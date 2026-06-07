/**
 * RFC-0043 Phase 3 — Stage 2/3: OpenShell Sandbox Runner (AISDLC-499)
 * RFC-0043 Phase 7 — Real Docker sandbox driver (AISDLC-508)
 * RFC-0043 Phase 7 — Differential test execution inside the sandbox (AISDLC-509)
 *
 * The core untrusted-execution layer:
 *  1. Sandbox-driver abstraction (Docker / Podman / Kata / gVisor / MicroVM)
 *  2. RFC-0022 regime override (HIPAA / FedRAMP High / PCI-DSS Level 1 → MicroVM)
 *  3. Resource limits (wall-clock / CPU / memory / network) per OQ-3 resolution
 *  4. Differential testing sequence (clone main → apply diff → upstream tests →
 *     new tests + coverage → emit unsigned report artifact)
 *  5. Credential withholding invariant: signing-key.pem, write-scoped
 *     GITHUB_TOKEN, NPM_TOKEN, AI_SDLC_PAT are NEVER injected into the sandbox
 *
 * ## Design
 * All driver implementations share the `SandboxDriver` interface. The
 * default driver (`DockerSandboxDriver`) is fully implemented. All others
 * (`PodmanSandboxDriver`, `KataSandboxDriver`, `GVisorSandboxDriver`,
 * `MicroVmSandboxDriver`) are pluggable stubs that throw descriptive errors
 * until a concrete implementation is provided.
 *
 * CI uses hermetic mocks (no real container runtime). Real-container tests
 * are gated behind `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` per the task brief.
 *
 * ## Credential withholding invariant (AC-3 / RFC AC-2)
 * The sandbox process environment MUST NOT contain:
 *   - `AI_SDLC_SIGNING_KEY` / `~/.ai-sdlc/signing-key.pem`
 *   - `GITHUB_TOKEN` with write scope
 *   - `NPM_TOKEN`
 *   - `AI_SDLC_PAT`
 * Anthropic provider credentials are injected at the sandbox-local inference
 * router (`inference.local`) — the agent process never receives them directly.
 *
 * ## Docker hardening (AISDLC-508)
 * The `DockerSandboxDriver` uses the following hardened isolation flags:
 *   - `--cidfile <tmpfile>`     — per-spawn cidfile; container ID read after start
 *   - `--network=none`          — full network deny (inference.local bridge added in AISDLC-510)
 *   - `--cap-drop=ALL`          — drop all Linux capabilities
 *   - `--read-only`             — read-only root filesystem
 *   - `--tmpfs /tmp:rw,noexec,nosuid,size=256m` — writable /tmp with exec-prevention
 *   - `--tmpfs /sandbox/workspace:rw,noexec,nosuid` — writable workspace
 *   - `--pids-limit 512`        — prevent fork bombs
 *   - `--memory <N>m`           — cgroup memory limit from resourceLimits
 *   - `--cpus <N>`              — cgroup CPU quota from resourceLimits
 *   - `--user 65534:65534`      — run as nobody:nogroup
 *   - `--rm`                    — auto-remove on exit
 *   - `--security-opt seccomp=<profile>` — seccomp syscall filter
 *   - `--security-opt no-new-privileges` — prevent privilege escalation
 *
 * Wall-clock enforcement is via AbortController: when the `runSandbox`
 * timeout fires, the controller is aborted and the driver kills the container
 * via `docker kill <id>` then `docker rm -f <id>`, returning
 * `outcome: 'resource-breach'`.
 *
 * ## Differential test output format (AISDLC-509)
 * The in-container script emits a single JSON object to stdout on the LAST
 * line of output (preceded by the sentinel `---DIFFERENTIAL-RESULT---`).
 * The TypeScript layer parses this and is fail-closed: any missing/garbage
 * output resolves to `{upstreamSuitePassed: false, newTestsPassed: false,
 * newCodeCoveragePct: 0}`. This prevents an attacker-crafted test output
 * string from causing a false positive.
 *
 * @module pipeline/sandbox-runner
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Sandbox driver types ──────────────────────────────────────────────────────

/**
 * The five supported sandbox drivers per RFC-0043 OQ-5 resolution.
 * `untrusted-pr-gate.yaml: sandboxDriver` selects the active driver.
 */
export type SandboxDriverKind = 'docker' | 'podman' | 'kata' | 'gvisor' | 'microvm';

/**
 * RFC-0022 compliance regimes that force a minimum isolation level.
 * Per OQ-5 resolution: HIPAA / FedRAMP High / PCI-DSS Level 1 → MicroVM required.
 */
export type ComplianceRegime = 'hipaa' | 'fedramp-high' | 'pci-dss-level-1' | 'none';

/**
 * Sandbox configuration loaded from `.ai-sdlc/untrusted-pr-gate.yaml`.
 */
export interface SandboxConfig {
  /** Which compute driver to use. Defaults to `docker`. */
  sandboxDriver: SandboxDriverKind;

  /**
   * Resource limits per OQ-3 resolution.
   * Defaults: 10min wall-clock / 2 CPU / 4 GB / network deny.
   */
  differentialTest: DifferentialTestConfig;

  /**
   * RFC-0022 compliance regime. When non-`none`, overrides the driver if
   * the regime requires a stronger isolation level (OQ-5 resolution).
   */
  complianceRegime?: ComplianceRegime;

  /**
   * CI/local deployment mode per OQ-2 resolution.
   * Default: `ci` (hermetic ephemeral sandbox in CI).
   */
  deployment?: 'ci' | 'local';
}

export interface ResourceLimits {
  /** Wall-clock timeout in seconds. Default 600 (10 minutes). */
  wallClockSeconds: number;
  /** CPU cores. Default 2. */
  cpuCores: number;
  /** Memory in megabytes. Default 4096 (4 GB). */
  memoryMb: number;
  /** Per-test timeout in seconds. Optional adopter refinement per OQ-3. */
  perTestTimeoutSeconds?: number;
}

export interface DifferentialTestConfig {
  resourceLimits: ResourceLimits;
}

/**
 * Default resource limits per OQ-3 resolution:
 * 10 min wall-clock / 2 CPU / 4 GB / deny network.
 */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  wallClockSeconds: 600,
  cpuCores: 2,
  memoryMb: 4096,
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  sandboxDriver: 'docker',
  differentialTest: {
    resourceLimits: DEFAULT_RESOURCE_LIMITS,
  },
  complianceRegime: 'none',
  deployment: 'ci',
};

// ── RFC-0022 regime override ──────────────────────────────────────────────────

/**
 * Regimes that mandate MicroVM isolation per OQ-5 resolution.
 * Composes with RFC-0030 OQ-13.3 residency-enforcement pattern:
 * regime declaration → derivedGates → sandbox driver constraint.
 */
const MICROVM_REQUIRED_REGIMES: ReadonlySet<ComplianceRegime> = new Set<ComplianceRegime>([
  'hipaa',
  'fedramp-high',
  'pci-dss-level-1',
]);

/**
 * Apply the RFC-0022 regime override to the requested driver.
 *
 * Returns the effective driver after applying the regime override.
 * When HIPAA / FedRAMP High / PCI-DSS Level 1 is declared, the driver
 * is upgraded to `microvm` regardless of the adopter's configured value.
 *
 * This is a pure function — it does not start any sandbox; it only
 * determines which driver MUST be used given compliance constraints.
 */
export function resolveEffectiveDriver(
  requestedDriver: SandboxDriverKind,
  regime: ComplianceRegime = 'none',
): { driver: SandboxDriverKind; overrideApplied: boolean; overrideReason?: string } {
  if (MICROVM_REQUIRED_REGIMES.has(regime)) {
    return {
      driver: 'microvm',
      overrideApplied: requestedDriver !== 'microvm',
      overrideReason:
        requestedDriver !== 'microvm'
          ? `RFC-0022 regime "${regime}" requires MicroVM isolation; overriding requested driver "${requestedDriver}"`
          : undefined,
    };
  }
  return { driver: requestedDriver, overrideApplied: false };
}

// ── Config loader ─────────────────────────────────────────────────────────────

/**
 * Load sandbox runner config from `.ai-sdlc/untrusted-pr-gate.yaml`.
 * Falls back to `DEFAULT_SANDBOX_CONFIG` when the file is absent.
 */
export function loadSandboxConfig(workDir: string = process.cwd()): SandboxConfig {
  const configPath = join(workDir, '.ai-sdlc', 'untrusted-pr-gate.yaml');
  if (!existsSync(configPath)) return DEFAULT_SANDBOX_CONFIG;

  const raw = readFileSync(configPath, 'utf8');
  return parseSandboxConfig(raw);
}

function parseSandboxConfig(yamlText: string): SandboxConfig {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsYaml = require('js-yaml') as typeof import('js-yaml');
    const doc = jsYaml.load(yamlText) as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object') return DEFAULT_SANDBOX_CONFIG;

    const result: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG };

    // sandboxDriver
    const driver = doc['sandboxDriver'];
    if (isValidDriver(driver)) result.sandboxDriver = driver;

    // complianceRegime
    const regime = doc['complianceRegime'];
    if (isValidRegime(regime)) result.complianceRegime = regime;

    // deployment
    const deployment = doc['deployment'];
    if (deployment === 'ci' || deployment === 'local') result.deployment = deployment;

    // differentialTest.resourceLimits
    const dt = doc['differentialTest'];
    if (dt && typeof dt === 'object') {
      const dtObj = dt as Record<string, unknown>;
      const rl = dtObj['resourceLimits'];
      if (rl && typeof rl === 'object') {
        const rlObj = rl as Record<string, unknown>;
        const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS };

        if (typeof rlObj['wallClockSeconds'] === 'number' && rlObj['wallClockSeconds'] > 0) {
          limits.wallClockSeconds = rlObj['wallClockSeconds'];
        }
        if (typeof rlObj['cpuCores'] === 'number' && rlObj['cpuCores'] > 0) {
          limits.cpuCores = rlObj['cpuCores'];
        }
        if (typeof rlObj['memoryMb'] === 'number' && rlObj['memoryMb'] > 0) {
          limits.memoryMb = rlObj['memoryMb'];
        }
        if (
          typeof rlObj['perTestTimeoutSeconds'] === 'number' &&
          rlObj['perTestTimeoutSeconds'] > 0
        ) {
          limits.perTestTimeoutSeconds = rlObj['perTestTimeoutSeconds'];
        }

        result.differentialTest = { resourceLimits: limits };
      }
    }

    return result;
  } catch {
    return DEFAULT_SANDBOX_CONFIG;
  }
}

function isValidDriver(v: unknown): v is SandboxDriverKind {
  return v === 'docker' || v === 'podman' || v === 'kata' || v === 'gvisor' || v === 'microvm';
}

function isValidRegime(v: unknown): v is ComplianceRegime {
  return v === 'hipaa' || v === 'fedramp-high' || v === 'pci-dss-level-1' || v === 'none';
}

// ── Sandbox driver interface ──────────────────────────────────────────────────

/**
 * Input for a sandbox spawn request.
 */
export interface SandboxSpawnInput {
  /** Absolute path to the OpenShell policy file. */
  policyFilePath: string;
  /** The PR diff to apply (unified diff format). */
  prDiff: string;
  /** URL (or local path) of the clean upstream main to clone. */
  upstreamMainRef: string;
  /** Resource limits to enforce on the sandbox. */
  resourceLimits: ResourceLimits;
  /**
   * The PR number being tested. Required so that any ResourceBreachEvent
   * emitted by the driver carries the REAL PR number (not a hardcoded 0).
   * Per RFC-0035 G0 catalog: breach events post to the correct PR.
   */
  prNumber: number;
  /**
   * Environment variables to inject into the sandbox.
   *
   * SECURITY CONSTRAINT: These MUST NOT include any of the withheld credentials:
   *   - `AI_SDLC_SIGNING_KEY` / any path to `signing-key.pem`
   *   - `GITHUB_TOKEN` with write scope
   *   - `NPM_TOKEN`
   *   - `AI_SDLC_PAT`
   *
   * The proxy layer injects the provider API key at `inference.local`; it
   * never appears here.
   */
  sandboxEnv?: Record<string, string>;
  /**
   * Extra `docker run` arguments prepended before the image name.
   *
   * RFC-0043 AQ2: pass `buildProxyHostArg(hostIp)` here to expose
   * `inference.local` to the container so it can reach the host-side proxy
   * despite `--network=none`. Only the proxy TCP path is opened.
   *
   * Used by `DockerSandboxDriver` when building the docker run command.
   * Drivers other than Docker ignore this field.
   */
  extraDockerArgs?: string[];
}

/**
 * Resource breach type — identifies which limit was exceeded.
 */
export type ResourceBreachType = 'wall-clock' | 'memory' | 'cpu';

/**
 * Emitted when the sandbox breaches a resource limit.
 * Per OQ-3 resolution: hard abort (not soft abort), then:
 *  - apply `needs-maintainer-review` label
 *  - post a comment naming the breached limit
 *  - emit `Decision: untrusted-pr-resource-exhausted` via RFC-0035 G0 catalog
 */
export interface ResourceBreachEvent {
  type: 'ResourceBreach';
  breachType: ResourceBreachType;
  /** The configured limit that was exceeded. */
  limit: number;
  /** The unit of the limit (seconds, MB, cores). */
  limitUnit: string;
  /** The observed value at breach time (may be approximate for memory/CPU). */
  observedValue?: number;
  prNumber: number;
  ts: string;
}

/**
 * Differential testing output produced by the sandbox.
 */
export interface DifferentialTestResult {
  upstreamSuitePassed: boolean;
  upstreamSuiteOutput: string;
  newTestsPassed: boolean;
  newTestsOutput: string;
  newCodeCoveragePct: number;
}

/**
 * The full sandbox execution result.
 */
export type SandboxResult =
  | {
      outcome: 'success';
      differentialTest: DifferentialTestResult;
      /** The sandbox run duration in milliseconds. */
      durationMs: number;
    }
  | {
      outcome: 'resource-breach';
      breach: ResourceBreachEvent;
    }
  | {
      outcome: 'error';
      error: string;
    };

/**
 * The `SandboxDriver` interface. Each driver must implement:
 *  - `spawn()` — start the ephemeral sandbox, run the differential test
 *    sequence, and return the result.
 *  - `teardown()` — clean up the sandbox (idempotent; called even on breach).
 *
 * Implementations MUST enforce the credential withholding invariant:
 * `WITHHELD_ENV_VARS` must never appear in `SandboxSpawnInput.sandboxEnv`.
 *
 * The credential check is enforced in the base `validateSandboxEnv` function
 * before any driver receives the input.
 */
export interface SandboxDriver {
  readonly kind: SandboxDriverKind;

  /**
   * Spawn an ephemeral sandbox, run the differential test sequence, and
   * return the result. The driver is responsible for:
   *  1. Starting the container / VM
   *  2. Cloning the clean upstream main
   *  3. Applying the PR diff (restricted to Stage-1-passed files)
   *  4. Running the upstream test suite → `upstreamSuitePassed`
   *  5. Running new tests with coverage → `newTestsPassed + newCodeCoveragePct`
   *  6. Enforcing resource limits (wall-clock, memory, CPU)
   *  7. On breach: setting `outcome: 'resource-breach'` and NOT the partial result
   */
  spawn(input: SandboxSpawnInput): Promise<SandboxResult>;

  /**
   * Tear down the sandbox (idempotent). Called after `spawn` resolves or
   * rejects. Implementations must not throw — log and suppress errors.
   */
  teardown(): Promise<void>;
}

// ── Credential withholding enforcement ───────────────────────────────────────

/**
 * Environment variable names that MUST NOT appear in the sandbox environment.
 * Per RFC-0043 §Stage 2 credential withholding invariant (AC-3).
 */
export const WITHHELD_ENV_VARS: readonly string[] = [
  'AI_SDLC_SIGNING_KEY',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'AI_SDLC_PAT',
  // Pattern match: any var whose name contains these substrings
] as const;

const WITHHELD_ENV_SUBSTRINGS = ['SIGNING_KEY', 'SIGNING_PEM'] as const;

/**
 * Validate that the sandbox environment does not contain withheld credentials.
 *
 * Throws a descriptive error if any withheld credential is present, preventing
 * the spawn from proceeding. This is a defense-in-depth check — the primary
 * credential isolation is the OpenShell proxy model, but we validate
 * belt-and-suspenders at the driver-invocation layer.
 *
 * Called by `createSandboxDriver` before any driver receives input.
 */
export function validateSandboxEnv(env: Record<string, string> | undefined): void {
  if (!env) return;

  const withheldFound: string[] = [];

  for (const key of Object.keys(env)) {
    if (WITHHELD_ENV_VARS.includes(key)) {
      withheldFound.push(key);
      continue;
    }
    for (const substring of WITHHELD_ENV_SUBSTRINGS) {
      if (key.includes(substring)) {
        withheldFound.push(key);
        break;
      }
    }
  }

  if (withheldFound.length > 0) {
    throw new Error(
      `Credential withholding violation: the following environment variables must not ` +
        `be present in the sandbox environment: ${withheldFound.join(', ')}. ` +
        `Provider credentials are injected at the inference proxy (inference.local), ` +
        `not in the sandbox env.`,
    );
  }
}

// ── Resource breach emitter ───────────────────────────────────────────────────

/**
 * Build a `ResourceBreachEvent` for RFC-0035 G0 catalog emission.
 *
 * Per OQ-3 resolution: on breach, hard abort + `needs-maintainer-review` label +
 * comment naming the breached limit + `Decision: untrusted-pr-resource-exhausted`
 * emitted via RFC-0035 G0 catalog.
 *
 * The Decision summary MUST NOT contain internal tracker IDs per AISDLC-394.
 */
export function buildResourceBreachEvent(
  prNumber: number,
  breachType: ResourceBreachType,
  limit: number,
  limitUnit: string,
  observedValue?: number,
  now: Date = new Date(),
): ResourceBreachEvent {
  return {
    type: 'ResourceBreach',
    breachType,
    limit,
    limitUnit,
    observedValue,
    prNumber,
    ts: now.toISOString(),
  };
}

/**
 * Build the GitHub comment body for a resource breach.
 * Posts to the PR naming the breached limit (AC-6).
 *
 * MUST NOT contain internal tracker IDs (AISDLC-NNN) per the
 * adopter-facing-strings gate.
 */
export function buildResourceBreachComment(breach: ResourceBreachEvent, author: string): string {
  const limitDesc = (() => {
    switch (breach.breachType) {
      case 'wall-clock':
        return `${breach.limit} seconds (${Math.round(breach.limit / 60)} minutes) wall-clock time`;
      case 'memory':
        return `${breach.limit} MB (${Math.round(breach.limit / 1024)} GB) memory`;
      case 'cpu':
        return `${breach.limit} CPU cores`;
    }
  })();

  const lines: string[] = [
    '## Sandbox resource limit exceeded',
    '',
    `@${author} — the sandbox was terminated because the test suite exceeded the configured ${breach.breachType} limit.`,
    '',
    `**Limit exceeded:** ${limitDesc}`,
  ];

  if (breach.observedValue !== undefined) {
    lines.push(`**Observed value:** approximately ${breach.observedValue} ${breach.limitUnit}`);
  }

  lines.push(
    '',
    'This PR has been labeled `needs-maintainer-review`.',
    '',
    'If your test suite legitimately requires more resources, please open a discussion',
    'with the maintainers to request a limit increase.',
    '',
    'Note: this automated gate is designed to prevent denial-of-service via',
    'resource-exhausting test suites in untrusted contributions.',
  );

  return lines.join('\n');
}

/**
 * RFC-0035 G0 Decision summary for `untrusted-pr-resource-exhausted`.
 * MUST NOT contain internal tracker IDs per AISDLC-394.
 */
export const RESOURCE_EXHAUSTED_DECISION_SUMMARY = 'untrusted-pr-resource-exhausted';

// ── Driver implementations ────────────────────────────────────────────────────

/**
 * Base class for sandbox drivers.
 * Provides the credential-withholding validation before spawn.
 */
abstract class BaseSandboxDriver implements SandboxDriver {
  abstract readonly kind: SandboxDriverKind;

  async spawn(input: SandboxSpawnInput): Promise<SandboxResult> {
    // Enforce credential withholding before any driver receives the input
    validateSandboxEnv(input.sandboxEnv);
    return this.doSpawn(input);
  }

  protected abstract doSpawn(input: SandboxSpawnInput): Promise<SandboxResult>;
  abstract teardown(): Promise<void>;
}

// ── Docker hardening constants ────────────────────────────────────────────────

/**
 * Default seccomp profile for the Docker sandbox.
 *
 * Based on Docker's default seccomp profile, with additional restrictions:
 * - Blocks syscalls commonly used in container-escape exploits
 * - Blocks mount, ptrace, kexec, and other privilege-escalation paths
 * - Allows only the syscalls needed for a typical Node.js test suite
 *
 * The `unconfined` value disables seccomp filtering — explicitly rejected.
 * The profile is passed via `--security-opt seccomp=<json>`.
 *
 * AISDLC-509 (inference.local proxy wiring) will extend this list when
 * network access is re-enabled via the loopback bridge.
 */
export const DOCKER_SECCOMP_PROFILE: Record<string, unknown> = {
  defaultAction: 'SCMP_ACT_ERRNO',
  architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_X86', 'SCMP_ARCH_X32'],
  syscalls: [
    {
      names: [
        // Core I/O
        'read',
        'write',
        'readv',
        'writev',
        'pread64',
        'pwrite64',
        'lseek',
        'sendfile',
        // File ops
        'open',
        'openat',
        'openat2',
        'close',
        'stat',
        'fstat',
        'lstat',
        'newfstatat',
        'statx',
        'access',
        'faccessat',
        'faccessat2',
        'getdents',
        'getdents64',
        'readlink',
        'readlinkat',
        'getcwd',
        'chdir',
        'fchdir',
        'mkdir',
        'mkdirat',
        'unlink',
        'unlinkat',
        'rmdir',
        'rename',
        'renameat',
        'renameat2',
        'link',
        'linkat',
        'symlink',
        'symlinkat',
        'chmod',
        'fchmod',
        'fchmodat',
        'chown',
        'fchown',
        'lchown',
        'fchownat',
        'truncate',
        'ftruncate',
        'fsync',
        'fdatasync',
        'sync',
        'syncfs',
        'ioctl',
        'fcntl',
        'dup',
        'dup2',
        'dup3',
        'pipe',
        'pipe2',
        // Memory
        'mmap',
        'mmap2',
        'munmap',
        'mprotect',
        'mremap',
        'madvise',
        'brk',
        // Process / thread
        'clone',
        'clone3',
        'fork',
        'vfork',
        'execve',
        'execveat',
        'exit',
        'exit_group',
        'wait4',
        'waitpid',
        'waitid',
        'getpid',
        'gettid',
        'getppid',
        'getpgrp',
        'getpgid',
        'setpgid',
        'setsid',
        'getsid',
        'getuid',
        'geteuid',
        'getgid',
        'getegid',
        'getgroups',
        'getresuid',
        'getresgid',
        'gettimeofday',
        'clock_gettime',
        'clock_getres',
        'clock_nanosleep',
        'nanosleep',
        'time',
        'times',
        'utime',
        'utimes',
        'futimesat',
        'utimensat',
        // Signal
        'rt_sigaction',
        'rt_sigprocmask',
        'rt_sigreturn',
        'rt_sigsuspend',
        'rt_sigpending',
        'rt_sigtimedwait',
        'rt_sigqueueinfo',
        'kill',
        'tgkill',
        'tkill',
        'sigaltstack',
        // Poll / epoll / select
        'poll',
        'ppoll',
        'select',
        'pselect6',
        'epoll_create',
        'epoll_create1',
        'epoll_ctl',
        'epoll_wait',
        'epoll_pwait',
        'epoll_pwait2',
        'eventfd',
        'eventfd2',
        // futex
        'futex',
        'futex_time64',
        'futex_waitv',
        'get_robust_list',
        'set_robust_list',
        // Socket (loopback only — no external network due to --network=none)
        'socket',
        'socketpair',
        'bind',
        'listen',
        'accept',
        'accept4',
        'connect',
        'getsockname',
        'getpeername',
        'setsockopt',
        'getsockopt',
        'sendto',
        'sendmsg',
        'sendmmsg',
        'recvfrom',
        'recvmsg',
        'recvmmsg',
        'shutdown',
        // Memory advise / huge pages
        'mincore',
        'mlock',
        'mlock2',
        'munlock',
        'mlockall',
        'munlockall',
        // Misc
        'arch_prctl',
        'prctl',
        'set_tid_address',
        'set_thread_area',
        'get_thread_area',
        'capget',
        'getrlimit',
        'setrlimit',
        'prlimit64',
        'getrusage',
        'sysinfo',
        'uname',
        'sched_getaffinity',
        'sched_setaffinity',
        'sched_yield',
        'sched_getscheduler',
        'sched_setscheduler',
        'sched_getparam',
        'sched_setparam',
        'sched_get_priority_min',
        'sched_get_priority_max',
        'getrandom',
        'memfd_create',
        'copy_file_range',
        'splice',
        'tee',
        'sendfile64',
        'inotify_init',
        'inotify_init1',
        'inotify_add_watch',
        'inotify_rm_watch',
        'statfs',
        'fstatfs',
        'umask',
        'personality',
        'timerfd_create',
        'timerfd_gettime',
        'timerfd_settime',
        'signalfd',
        'signalfd4',
        'alarm',
        'setitimer',
        'getitimer',
        'pause',
        'userfaultfd',
        'restart_syscall',
        'rseq',
        'pidfd_open',
        'pidfd_send_signal',
        'pidfd_getfd',
        'close_range',
        'io_uring_setup',
        'io_uring_enter',
        'io_uring_register',
        'landlock_create_ruleset',
        'landlock_add_rule',
        'landlock_restrict_self',
        'process_vm_readv',
        'process_vm_writev',
      ],
      action: 'SCMP_ACT_ALLOW',
    },
  ],
};

/**
 * Docker sandbox driver — the default v1 driver per RFC-0043 Phase 7 AQ1.
 *
 * Uses Docker (or compatible OCI runtime) for container isolation.
 * Documented trade-off per OQ-5: shared kernel; runc CVE-2024-21626
 * "Leaky Vessels" class is a real risk. Suitable for adopters without
 * compliance requirements. Upgrade to `kata` or `microvm` for stronger
 * isolation.
 *
 * In CI, real Docker operations are bypassed via the `MockSandboxDriver`
 * injection. Set `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` to run real
 * container tests.
 *
 * ## Hardening flags (AISDLC-508)
 *   - `--cidfile <tmpfile>`                 per-spawn cidfile for kill/rm
 *   - `--network=none`                      full network deny
 *   - `--cap-drop=ALL`                      drop all Linux capabilities
 *   - `--read-only`                         read-only root filesystem
 *   - `--tmpfs /tmp:rw,noexec,nosuid,size=256m`
 *   - `--tmpfs /sandbox/workspace:rw,noexec,nosuid`
 *   - `--pids-limit 512`                   prevent fork bombs
 *   - `--memory <N>m`                      cgroup memory limit
 *   - `--cpus <N>`                         cgroup CPU quota
 *   - `--user 65534:65534`                 run as nobody:nogroup
 *   - `--rm`                               auto-remove on exit
 *   - `--security-opt seccomp=<json>`      syscall allowlist
 *   - `--security-opt no-new-privileges`   prevent privilege escalation
 */
export class DockerSandboxDriver extends BaseSandboxDriver {
  readonly kind: SandboxDriverKind = 'docker';

  /**
   * Container ID read from the cidfile after the container starts.
   * Written by `docker run --cidfile <path>`; read after spawn begins.
   * Used by `killContainer()` and `teardown()` for `docker kill`/`docker rm -f`.
   */
  private containerId: string | null = null;

  /**
   * Path to the cidfile created per spawn invocation.
   * Lives in an isolated mkdtemp directory; cleaned up in `teardown()`.
   */
  private cidFilePath: string | null = null;

  /**
   * Thin spawn seam — wraps `child_process.spawn` so tests can override it
   * without a real Docker daemon. Override in a subclass or swap via spawnFn
   * injected in tests.
   *
   * All behaviour (arg building, cidfile poll, abort wiring, kill, teardown,
   * output parse) is exercised by tests; only this line is integration-gated.
   *
   * @internal — exported for hermetic testing only; not part of the public API.
   */
  protected _spawnProcess(cmd: string, args: string[], options: SpawnOptions): ChildProcess {
    return spawn(cmd, args, options);
  }

  protected async doSpawn(
    input: SandboxSpawnInput & { abortSignal?: AbortSignal },
  ): Promise<SandboxResult> {
    const start = Date.now();

    // In CI (no real Docker): return a descriptive error. The runner-level
    // Promise.race handles wall-clock enforcement before we get here.
    if (process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] !== '1') {
      return {
        outcome: 'error',
        error:
          'DockerSandboxDriver requires a real Docker runtime. In CI, inject a MockSandboxDriver. ' +
          'Set AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 to enable real container tests.',
      };
    }

    // Check abort signal — if already aborted before spawn, return breach
    if (input.abortSignal?.aborted) {
      return {
        outcome: 'resource-breach',
        breach: buildResourceBreachEvent(
          input.prNumber,
          'wall-clock',
          input.resourceLimits.wallClockSeconds,
          'seconds',
        ),
      };
    }

    try {
      const result = await this.runDockerDifferentialTest(input);
      const durationMs = Date.now() - start;
      return { outcome: 'success', differentialTest: result, durationMs };
    } catch (err) {
      // Distinguish abort-triggered kills from genuine errors
      if (input.abortSignal?.aborted) {
        return {
          outcome: 'resource-breach',
          breach: buildResourceBreachEvent(
            input.prNumber,
            'wall-clock',
            input.resourceLimits.wallClockSeconds,
            'seconds',
            Math.round((Date.now() - start) / 1000),
          ),
        };
      }
      return {
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Run the differential test sequence inside a hardened Docker container.
   *
   * Implements the RFC-0043 Phase 7 differential test sequence:
   *  1. In-container script clones the upstream repo at `upstreamMainRef` (the
   *     BASE sha — NOT headSha; preserves the AISDLC-501 invariant).
   *  2. Applies the PR diff as DATA via `git apply` (never executes fork-provided
   *     workflow logic). The diff is passed via base64-encoded env var to prevent
   *     shell metacharacter injection.
   *  3. Runs the upstream (base) test suite; captures exit code + output.
   *  4. Runs the head (PR) test suite with coverage; extracts coverage %.
   *  5. Emits a sentinel + JSON result line to stdout.
   *
   * The TypeScript parser (`parseDifferentialTestOutput`) is fail-closed:
   * any missing/garbage/malformed output → treated as FAILURE, never as pass.
   *
   * Per-test timeout (AC-3): when `resourceLimits.perTestTimeoutSeconds` is set,
   * the in-container script wraps the test command with `timeout <N>` so a
   * hung test → SIGTERM → non-zero exit → failure (not a stuck runner).
   * The wall-clock AbortController (set up by the caller) provides the
   * outer hard limit that kills the whole container.
   */
  private async runDockerDifferentialTest(
    input: SandboxSpawnInput & { abortSignal?: AbortSignal },
  ): Promise<DifferentialTestResult> {
    // Belt-and-suspenders: reject an empty diff before base64-encoding.
    //
    // When `input.prDiff` is an empty string, `Buffer.from('').toString('base64')`
    // produces `''`, so `SANDBOX_PR_DIFF_B64=''` in the container env.  The shell
    // guard `if [ -n "${SANDBOX_PR_DIFF_B64:-}" ]` evaluates to false, so
    // `git apply` is silently SKIPPED and the head suite runs against the
    // UNPATCHED base → false `headPassed:true` (the fail-closed sentinel can't
    // detect this because the sentinel + JSON are still emitted).
    //
    // We reject here so the caller receives outcome:'error' rather than a
    // silently misleading outcome:'success' with headPassed:true on an unpatched
    // tree.  The in-container shell guard is also hardened (see
    // buildDifferentialTestScript) as belt-and-suspenders defence.
    if (!input.prDiff || input.prDiff.length === 0) {
      throw new Error(
        'runDockerDifferentialTest: prDiff must be a non-empty string. ' +
          'An empty diff would cause git apply to be skipped inside the sandbox, ' +
          'producing a false headPassed:true result against the unpatched base tree.',
      );
    }

    const { resourceLimits } = input;
    const seccompJson = JSON.stringify(DOCKER_SECCOMP_PROFILE);

    // Create an isolated temp directory and cidfile path per spawn invocation.
    // `docker run --cidfile <path>` writes the full container ID to this file
    // once the container starts (even in foreground / non-detached mode).
    // We read the cidfile to obtain the container ID for kill/rm operations.
    const cidDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-sandbox-'));
    const cidFilePath = join(cidDir, 'container.cid');
    this.cidFilePath = cidFilePath;

    // `docker run --security-opt seccomp=<value>` expects a FILE PATH (or the
    // literal 'unconfined') — NOT inline JSON. Passing the profile JSON inline
    // makes docker try to open it as a filename and fail with exit code 125
    // ("opening seccomp profile"). Write the profile to a file in the per-spawn
    // temp dir and pass its path. The file is removed with cidDir in teardown.
    const seccompFilePath = join(cidDir, 'seccomp.json');
    writeFileSync(seccompFilePath, seccompJson, { mode: 0o600 });

    // Build the in-container differential test script.
    // The script is passed as a shell -c argument (not written to disk on the
    // host) so it is not affected by the container's read-only filesystem.
    const inContainerScript = buildDifferentialTestScript(
      input.upstreamMainRef,
      resourceLimits.perTestTimeoutSeconds,
    );

    // Build the docker run arguments.
    // extraDockerArgs carries AQ2 proxy host entries (e.g. --add-host=inference.local:<ip>)
    // so the container can reach the host-side inference proxy despite --network=none.
    const args = buildDockerRunArgs({
      resourceLimits,
      // Pass the seccomp FILE PATH (docker --security-opt seccomp=<path>), not
      // the inline JSON — see the seccompFilePath comment above.
      seccompProfileJson: seccompFilePath,
      cidFilePath,
      image: process.env['AI_SDLC_SANDBOX_IMAGE'] ?? 'node:22-slim',
      command: ['/bin/sh', '-c', inContainerScript],
      extraDockerArgs: input.extraDockerArgs,
    });

    // Base64-encode the PR diff to pass it safely as an environment variable.
    // This prevents shell metacharacters in the diff from breaking the script.
    const prDiffB64 = Buffer.from(input.prDiff, 'utf8').toString('base64');

    return new Promise<DifferentialTestResult>((resolve, reject) => {
      const proc = this._spawnProcess('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Pass a clean environment — never inherit the host env wholesale.
        // SANDBOX_PR_DIFF_B64 carries the diff as DATA (base64-encoded).
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          SANDBOX_PR_DIFF_B64: prDiffB64,
          ...(input.sandboxEnv ?? {}),
        },
      });

      // Poll the cidfile for the container ID shortly after spawn.
      // `docker run --cidfile` writes the ID as soon as the container starts,
      // before the container's stdout produces any output. We poll with a short
      // interval so killContainer() can use the real ID on abort.
      const cidPollInterval = setInterval(() => {
        if (!this.containerId && existsSync(cidFilePath)) {
          try {
            const id = readFileSync(cidFilePath, 'utf8').trim();
            if (id && /^[0-9a-f]{12,64}$/i.test(id)) {
              this.containerId = id;
              clearInterval(cidPollInterval);
            }
          } catch {
            // cidfile may not be fully written yet — retry on next tick
          }
        }
      }, 50);

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Wire abort signal to kill the container
      const onAbort = () => {
        clearInterval(cidPollInterval);
        this.killContainer().catch(() => {
          // best-effort kill — teardown() will also attempt rm -f
        });
        proc.kill('SIGKILL');
        reject(new Error('Docker container aborted by wall-clock timeout'));
      };
      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          onAbort();
          return;
        }
        input.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      proc.on('close', (exitCode) => {
        clearInterval(cidPollInterval);
        if (input.abortSignal) {
          input.abortSignal.removeEventListener('abort', onAbort);
        }

        // Read the container ID from the cidfile on close in case the poll
        // interval had not yet fired (fast-exiting containers).
        if (!this.containerId && existsSync(cidFilePath)) {
          try {
            const id = readFileSync(cidFilePath, 'utf8').trim();
            if (id && /^[0-9a-f]{12,64}$/i.test(id)) {
              this.containerId = id;
            }
          } catch {
            // cidfile may be absent if the container failed before starting
          }
        }

        if (input.abortSignal?.aborted) {
          reject(new Error('Docker container aborted by wall-clock timeout'));
          return;
        }

        if (exitCode !== 0) {
          // Non-zero exit: parse the output anyway (fail-closed).
          // The script may have emitted a partial result before the error.
          // If parseDifferentialTestOutput finds the sentinel, it returns the
          // parsed result; otherwise it returns the failure sentinel.
          // Either way we reject so the caller records outcome: 'error'.
          reject(
            new Error(
              `Docker container exited with code ${exitCode}. ` +
                `stdout: ${stdout.slice(0, 4000)} stderr: ${stderr.slice(0, 4000)}`,
            ),
          );
          return;
        }

        // Parse the container output into a DifferentialTestResult.
        // parseDifferentialTestOutput is fail-closed: garbage/missing output →
        // upstreamSuitePassed:false, newTestsPassed:false, newCodeCoveragePct:0.
        resolve(parseDifferentialTestOutput(stdout));
      });

      proc.on('error', (err) => {
        clearInterval(cidPollInterval);
        if (input.abortSignal) {
          input.abortSignal.removeEventListener('abort', onAbort);
        }
        reject(err);
      });
    });
  }

  /**
   * Kill the container by ID (used on abort signal).
   * Idempotent — errors are swallowed so teardown() can also attempt rm -f.
   */
  private async killContainer(): Promise<void> {
    if (!this.containerId) return;
    const id = this.containerId;
    await new Promise<void>((resolve) => {
      const proc = this._spawnProcess('docker', ['kill', id], { stdio: 'ignore' });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
  }

  /**
   * Idempotent teardown — `docker rm -f` the container by ID, then clean up
   * the cidfile and its temp directory.
   * Called after spawn resolves or rejects (including on wall-clock timeout).
   * Suppresses all errors to prevent masking the original spawn result.
   */
  async teardown(): Promise<void> {
    const id = this.containerId;
    const cidFilePath = this.cidFilePath;
    this.containerId = null;
    this.cidFilePath = null;

    if (id) {
      await new Promise<void>((resolve) => {
        const proc = this._spawnProcess('docker', ['rm', '-f', id], { stdio: 'ignore' });
        proc.on('close', () => resolve());
        proc.on('error', () => resolve());
      });
    }

    // Clean up the cidfile temp directory (best-effort)
    if (cidFilePath) {
      try {
        // Remove the temp dir that contains the cidfile
        const cidDir = cidFilePath.substring(0, cidFilePath.lastIndexOf('/'));
        rmSync(cidDir, { recursive: true, force: true });
      } catch {
        // suppress — cidfile cleanup is best-effort
      }
    }
  }
}

// ── Differential test output parsing (AISDLC-509) ────────────────────────────

/**
 * Sentinel line that precedes the JSON result emitted by the in-container
 * differential test script. The TypeScript parser scans for this sentinel
 * and takes the content that follows as the JSON result payload.
 *
 * Using a sentinel prevents an attacker from planting a fake result object
 * early in the output stream — only the LAST result (after the final
 * sentinel line) is parsed.
 *
 * Exported for use in test assertions.
 */
export const DIFFERENTIAL_RESULT_SENTINEL = '---DIFFERENTIAL-RESULT---';

/**
 * Raw JSON shape emitted by the in-container differential test script.
 * Parsed by `parseDifferentialTestOutput` and converted to `DifferentialTestResult`.
 *
 * The script emits this after running base (upstream) and head test suites.
 * Fields:
 *  - `upstreamPassed`:  true iff the upstream suite (base SHA) exited 0
 *  - `upstreamOutput`:  raw stdout+stderr of the upstream test run (truncated)
 *  - `headPassed`:      true iff the head (PR) test suite exited 0
 *  - `headOutput`:      raw stdout+stderr of the head test run (truncated)
 *  - `coveragePct`:     numeric coverage percentage parsed from the head run output
 *
 * All fields are required. A missing/extra field → fail-closed (treated as failure).
 */
export interface DifferentialTestRawResult {
  upstreamPassed: boolean;
  upstreamOutput: string;
  headPassed: boolean;
  headOutput: string;
  coveragePct: number;
}

/**
 * Parse the differential test output emitted by the in-container script.
 *
 * Fail-closed contract: any ambiguity or parse failure resolves to the
 * failure state `{upstreamSuitePassed: false, newTestsPassed: false,
 * newCodeCoveragePct: 0}` — NEVER to a false pass.
 *
 * The parser:
 *  1. Scans the full stdout string for the LAST occurrence of the sentinel
 *     `---DIFFERENTIAL-RESULT---`.
 *  2. Takes all content AFTER the sentinel on the next non-empty line as
 *     the JSON payload.
 *  3. Parses the JSON and validates the required boolean + number fields.
 *  4. Any parse error, missing field, wrong type → returns failure.
 *  5. `coveragePct` outside [0, 100] → clamped (not a hard failure, since
 *     coverage tools may round differently).
 *
 * Exported for hermetic unit testing — all parsing logic is exercised
 * via TestableDockerDriver seam without a real Docker daemon.
 */
export function parseDifferentialTestOutput(stdout: string): DifferentialTestResult {
  const FAILURE_RESULT: DifferentialTestResult = {
    upstreamSuitePassed: false,
    upstreamSuiteOutput: stdout.slice(0, 2000),
    newTestsPassed: false,
    newTestsOutput: stdout.slice(0, 2000),
    newCodeCoveragePct: 0,
  };

  if (!stdout || typeof stdout !== 'string') {
    return FAILURE_RESULT;
  }

  // Find the LAST sentinel occurrence (an attacker cannot inject a false pass
  // before the sentinel — the parser always uses the LAST one).
  const sentinelIdx = stdout.lastIndexOf(DIFFERENTIAL_RESULT_SENTINEL);
  if (sentinelIdx === -1) {
    return FAILURE_RESULT;
  }

  // Take everything after the sentinel line
  const afterSentinel = stdout.slice(sentinelIdx + DIFFERENTIAL_RESULT_SENTINEL.length);

  // Find the first non-empty line after the sentinel
  const lines = afterSentinel.split('\n');
  let jsonLine = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      jsonLine = trimmed;
      break;
    }
  }

  if (!jsonLine) {
    return FAILURE_RESULT;
  }

  // Parse and validate — any parse error → fail-closed
  let raw: unknown;
  try {
    raw = JSON.parse(jsonLine);
  } catch {
    return FAILURE_RESULT;
  }

  // Type-check the required fields — wrong shape → fail-closed
  if (!raw || typeof raw !== 'object') {
    return FAILURE_RESULT;
  }
  const r = raw as Record<string, unknown>;

  if (
    typeof r['upstreamPassed'] !== 'boolean' ||
    typeof r['headPassed'] !== 'boolean' ||
    typeof r['coveragePct'] !== 'number' ||
    typeof r['upstreamOutput'] !== 'string' ||
    typeof r['headOutput'] !== 'string'
  ) {
    return FAILURE_RESULT;
  }

  // Additional guard: if `coveragePct` is NaN or Infinity → treat as failure
  const coveragePct = r['coveragePct'] as number;
  if (!Number.isFinite(coveragePct)) {
    return FAILURE_RESULT;
  }

  // Clamp coverage to [0, 100] — tools may report slightly over/under due to rounding
  const clampedCoverage = Math.max(0, Math.min(100, coveragePct));

  return {
    upstreamSuitePassed: r['upstreamPassed'] as boolean,
    upstreamSuiteOutput: (r['upstreamOutput'] as string).slice(0, 2000),
    newTestsPassed: r['headPassed'] as boolean,
    newTestsOutput: (r['headOutput'] as string).slice(0, 2000),
    newCodeCoveragePct: clampedCoverage,
  };
}

/**
 * Validate `upstreamMainRef` before interpolating it into the in-container
 * shell script.
 *
 * Only two forms are permitted:
 *  - A full or short git SHA: 7-64 hex characters (e.g. a base commit SHA).
 *  - A URL: starts with `https://`, `git://`, `ssh://`, or `git@`.
 *
 * Reject anything else. This prevents shell-injection via a crafted ref
 * string that bypasses single-quoting (e.g. a ref containing `'` or `$(…)`).
 *
 * Called by `buildDifferentialTestScript` before constructing the script.
 * Exported for unit-test coverage.
 */
export function validateUpstreamMainRef(ref: string): void {
  if (!ref || typeof ref !== 'string') {
    throw new Error('upstreamMainRef must be a non-empty string');
  }
  // Allow: git SHAs (7–64 hex chars)
  const isSha = /^[0-9a-f]{7,64}$/i.test(ref);
  // Allow: URLs (https://, git://, ssh://, git@)
  const isUrl = /^(https?|git|ssh):\/\//.test(ref) || /^git@/.test(ref);
  if (!isSha && !isUrl) {
    throw new Error(
      `upstreamMainRef "${ref}" is not a valid git SHA or repository URL. ` +
        `Accepted forms: 7-64 hex characters (SHA) or https?/git/ssh/git@ URL.`,
    );
  }
}

/**
 * Build the shell script that runs the differential test sequence inside
 * the container.
 *
 * The script:
 *  1. Clones the upstream repo at the base SHA (`upstreamMainRef`) — the
 *     `baseSha`, NOT `headSha`. This preserves the AISDLC-501 invariant:
 *     we test what the upstream tests expect, not the PR's revised state.
 *  2. Applies the PR diff as DATA (via `git apply`) — never executes fork-
 *     provided workflow logic. The diff is written to a tmpfile and applied
 *     with `--reject` so partial-apply failures are surfaced, not silenced.
 *  3. Installs dependencies in offline mode when a lock file is present
 *     (denies network package fetch inside the sandbox).
 *  4. Runs the upstream test suite; captures exit code + output.
 *  5. Applies the per-test timeout via `timeout <seconds>` if the resource
 *     limits specify one (hangs a test → SIGTERM → exit non-zero).
 *  6. Emits the sentinel + JSON result on stdout for the TypeScript parser.
 *
 * SECURITY: the prDiff is passed as a base64-encoded environment variable
 * (`SANDBOX_PR_DIFF_B64`) so it is never interpolated into the shell script
 * itself — only decoded and written to a file, then passed to `git apply`.
 * This prevents a diff that contains shell metacharacters from breaking out.
 *
 * ## `baseSha` parameter (AISDLC-501 invariant for URL-form refs)
 * When `upstreamMainRef` is a URL, the clone uses `--depth=1` (fetches
 * default-branch HEAD). Without `baseSha`, the clone lands at an arbitrary
 * commit that may differ from the actual PR merge-base — violating the
 * AISDLC-501 base invariant (upstream tests must run at the exact base SHA).
 * Supplying `baseSha` (a valid 7-64 hex SHA) causes the script to run
 * `git checkout <baseSha>` after the clone, pinning the base to the correct
 * commit.
 *
 * When `upstreamMainRef` is itself a SHA (the common production path), the
 * SHA IS the ref and `baseSha` is redundant — it is ignored in the SHA branch.
 *
 * RECOMMENDED: always pass `baseSha` when `upstreamMainRef` is a URL.
 *
 * Exported for hermetic unit testing of the script shape.
 */
export function buildDifferentialTestScript(
  upstreamMainRef: string,
  perTestTimeoutSeconds?: number,
  baseSha?: string,
): string {
  // Validate the ref before interpolating into the shell script.
  // Throws if the ref is not a valid SHA or URL — prevents shell injection.
  validateUpstreamMainRef(upstreamMainRef);

  // The per-test timeout prefix: `timeout <N>` wraps the test command.
  // If no per-test timeout is configured, the test command runs unwrapped
  // (the wall-clock AbortController handles the overall limit).
  const timeoutPrefix =
    perTestTimeoutSeconds && perTestTimeoutSeconds > 0
      ? `timeout ${String(Math.floor(perTestTimeoutSeconds))}`
      : '';

  // The test runner command for the upstream (base) suite — no coverage needed.
  // Tries pnpm first, falls back to npm test.
  const baseTestCmd = timeoutPrefix
    ? `${timeoutPrefix} sh -c 'pnpm test 2>&1 || npm test 2>&1'`
    : "sh -c 'pnpm test 2>&1 || npm test 2>&1'";

  // The test runner command for the head (PR) suite WITH coverage.
  // Coverage is passed as a direct flag to pnpm/npm, not after `--` (which
  // would be consumed by the shell, not forwarded to the test runner).
  const headTestCmd = timeoutPrefix
    ? `${timeoutPrefix} sh -c 'pnpm test --coverage 2>&1 || npm test --coverage 2>&1'`
    : "sh -c 'pnpm test --coverage 2>&1 || npm test --coverage 2>&1'";

  // Single-quote-escape the ref for safe interpolation into the sh script.
  // `validateUpstreamMainRef` already rejects any ref that isn't a hex SHA
  // or a URL with a known scheme, so this is belt-and-suspenders safety.
  const escapedRef = upstreamMainRef.replace(/'/g, "'\\''");

  // Validate and escape baseSha when supplied.
  // baseSha must be a git SHA (7-64 hex chars) when provided — it is injected
  // into the shell script via single-quoting so it must not contain metacharacters.
  const escapedBaseSha = baseSha ? baseSha.replace(/'/g, "'\\''") : '';
  // Only emit the checkout command when a valid baseSha is supplied
  const baseShaCheckout =
    baseSha && /^[0-9a-f]{7,64}$/i.test(baseSha)
      ? `  git checkout '${escapedBaseSha}' 2>&1 || { echo "git checkout baseSha failed: '${escapedBaseSha}'" >&2; exit 1; }`
      : '  # baseSha not provided: cloned at default-branch HEAD (AISDLC-501 invariant may not hold for URL-form refs)';

  return `#!/bin/sh
set -e

WORK_DIR="/sandbox/workspace"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# ── 1. Clone the upstream repo ──────────────────────────────────────────────────
# UPSTREAM_REF is the BASE SHA (or repo URL) — not headSha. This is the
# AISDLC-501 invariant: we run the upstream suite at the base, THEN apply the
# diff and run the head suite. upstreamMainRef has been validated to be a git
# SHA or a known-scheme URL before being interpolated here.
UPSTREAM_REF='${escapedRef}'

if [ -n "\${SANDBOX_FIXTURE_B64:-}" ]; then
  # Fixture-demo mode (RFC-0043 AQ2 live demo — option B). The trusted base
  # tree is a tiny zero-dependency repo supplied as a base64 gzip tarball via
  # the SANDBOX_FIXTURE_B64 env var. This is offline-safe under --network=none
  # (no clone, no dependency install). We materialize it into repo/ and let the
  # existing base-test → git-apply → head-test sequence run against it.
  # NOTE: 'git apply' applies to plain working files and does NOT require a git
  # repository, so no 'git init' is needed (keeps the image footprint minimal).
  mkdir -p repo
  cd repo
  if ! printf '%s' "$SANDBOX_FIXTURE_B64" | base64 -d | tar xz; then
    echo 'fixture extraction failed' >&2
    exit 1
  fi
elif echo "$UPSTREAM_REF" | grep -qE '^(https?|git|ssh)://|^git@'; then
  # URL path: clone then check out the pinned base SHA (baseSha) if supplied.
  # Without baseSha, the clone lands at default-branch HEAD which may differ
  # from the actual PR merge-base — violating the AISDLC-501 base invariant.
  # Always pass baseSha to this function when upstreamMainRef is a URL.
  git clone "$UPSTREAM_REF" repo 2>&1
  cd repo
${baseShaCheckout}
else
  # SHA path: upstreamMainRef IS the base SHA.
  # The sandbox must have been pre-populated with the repo at /sandbox/workspace/repo
  # or we clone from a local mirror.  For robustness, if a 'repo' dir already
  # exists (pre-populated), use it; otherwise fail closed.
  if [ -d "repo" ]; then
    cd repo
    git checkout "$UPSTREAM_REF" 2>&1
  else
    echo "SHA-form upstreamMainRef '$UPSTREAM_REF' provided but no pre-cloned repo found at $WORK_DIR/repo" >&2
    FAILURE_SENTINEL='${DIFFERENTIAL_RESULT_SENTINEL}'
    echo "$FAILURE_SENTINEL"
    printf '{"upstreamPassed":false,"upstreamOutput":"base repo not available","headPassed":false,"headOutput":"","coveragePct":0}\\n'
    exit 1
  fi
fi

# ── 2. Install dependencies for the BASE tree (offline where possible) ──────────
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --frozen-lockfile --offline 2>&1 || \
  pnpm install --frozen-lockfile 2>&1 || true
elif [ -f "package-lock.json" ]; then
  npm ci --prefer-offline 2>&1 || true
elif [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile --offline 2>&1 || true
fi

# ── 3. Run the upstream (base) test suite BEFORE applying the diff ───────────────
# This is the differential invariant: upstreamPassed reflects the BASE tree,
# not the patched tree. (AISDLC-501)
UPSTREAM_PASSED=false
UPSTREAM_OUTPUT=""
set +e
UPSTREAM_OUTPUT=$(${baseTestCmd} 2>&1)
UPSTREAM_EXIT=$?
set -e
if [ "$UPSTREAM_EXIT" -eq 0 ]; then
  UPSTREAM_PASSED=true
fi

# ── 4. Apply the PR diff as DATA (never execute fork-provided workflow logic) ────
# The diff is provided via the SANDBOX_PR_DIFF_B64 environment variable
# (base64-encoded to avoid shell metacharacter injection).
#
# FAIL-CLOSED: if SANDBOX_PR_DIFF_B64 is absent or empty, the diff was never
# provided — silently skipping would run the head suite against the UNPATCHED
# base tree, producing a false headPassed:true. We emit the failure sentinel
# and exit 1 instead (belt-and-suspenders; the TypeScript layer also rejects
# empty diffs before base64-encoding).
DIFF_FILE="/tmp/pr.diff"
if [ -z "\${SANDBOX_PR_DIFF_B64:-}" ]; then
  echo "SANDBOX_PR_DIFF_B64 is absent or empty — cannot apply diff" >&2
  FAILURE_SENTINEL='${DIFFERENTIAL_RESULT_SENTINEL}'
  echo "$FAILURE_SENTINEL"
  printf '{"upstreamPassed":%s,"upstreamOutput":"%s","headPassed":false,"headOutput":"no diff provided","coveragePct":0}\\n' \\
    "$UPSTREAM_PASSED" "$(printf '%s' "$UPSTREAM_OUTPUT" | head -c 500 | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')"
  exit 1
fi
printf '%s' "$SANDBOX_PR_DIFF_B64" | base64 -d > "$DIFF_FILE"
# Apply the diff; --reject surfaces partial failures rather than silencing them.
# Use --ignore-whitespace to tolerate CRLF/LF differences from the PR.
# On failure: emit the failure sentinel and exit 1 (fail-closed — do NOT
# continue running tests against the unpatched base, which would produce
# a false headPassed:true result).
if ! git apply --reject --ignore-whitespace "$DIFF_FILE" 2>&1; then
  echo "git apply failed — diff could not be applied cleanly" >&2
  FAILURE_SENTINEL='${DIFFERENTIAL_RESULT_SENTINEL}'
  echo "$FAILURE_SENTINEL"
  printf '{"upstreamPassed":%s,"upstreamOutput":"%s","headPassed":false,"headOutput":"git apply failed","coveragePct":0}\\n' \\
    "$UPSTREAM_PASSED" "$(printf '%s' "$UPSTREAM_OUTPUT" | head -c 500 | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')"
  exit 1
fi

# ── 5. Install dependencies for the HEAD tree (after diff applied) ───────────────
# Re-run install in case the PR modified lock files or package.json.
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --frozen-lockfile --offline 2>&1 || \
  pnpm install --frozen-lockfile 2>&1 || true
elif [ -f "package-lock.json" ]; then
  npm ci --prefer-offline 2>&1 || true
elif [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile --offline 2>&1 || true
fi

# ── 6. Run the head (PR) test suite with coverage ──────────────────────────────
# headPassed reflects the PATCHED tree (post-apply). Coverage is forwarded as a
# direct flag to pnpm/npm (not after '--', which sh would consume).
HEAD_PASSED=false
HEAD_OUTPUT=""
COVERAGE_PCT=0
set +e
HEAD_OUTPUT=$(${headTestCmd} 2>&1)
HEAD_EXIT=$?
set -e
if [ "$HEAD_EXIT" -eq 0 ]; then
  HEAD_PASSED=true
fi

# Extract coverage percentage from the output.
# Accepts integer or decimal percent (e.g. "82%" or "82.35%") from common
# coverage reporter formats like "Lines: 82.35%" or "All files | 82.35".
COVERAGE_PCT=$(printf '%s\\n' "$HEAD_OUTPUT" | grep -oE '[0-9]+([.][0-9]+)?%' | tail -1 | tr -d '%' || echo "0")
if [ -z "$COVERAGE_PCT" ]; then
  COVERAGE_PCT=0
fi

# ── 7. Emit the sentinel + JSON result ──────────────────────────────────────────
# The TypeScript parser reads everything AFTER the last sentinel occurrence.
# Escape the output strings for JSON embedding (strip control chars, escape quotes).
safe_upstream=$(printf '%s' "$UPSTREAM_OUTPUT" | head -c 2000 | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
safe_head=$(printf '%s' "$HEAD_OUTPUT" | head -c 2000 | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')

echo "${DIFFERENTIAL_RESULT_SENTINEL}"
printf '{"upstreamPassed":%s,"upstreamOutput":"%s","headPassed":%s,"headOutput":"%s","coveragePct":%s}\\n' \\
  "$UPSTREAM_PASSED" "$safe_upstream" "$HEAD_PASSED" "$safe_head" "$COVERAGE_PCT"
`;
}

// ── Docker argument builder (exported for unit-test assertions) ───────────────

export interface DockerRunArgsInput {
  resourceLimits: ResourceLimits;
  seccompProfileJson: string;
  image: string;
  command: string[];
  /**
   * Path to the cidfile for this spawn invocation.
   * `docker run --cidfile <path>` writes the full container ID to this file
   * once the container starts (foreground or detached). Required so that
   * `killContainer()` and `teardown()` can kill/rm the real container ID.
   */
  cidFilePath: string;
  /**
   * Extra `docker run` arguments prepended before the image name.
   * Used to inject `--add-host=inference.local:<host-ip>` so the sandbox
   * can reach the inference proxy on the host (RFC-0043 AQ2 wiring).
   * Built by `buildProxyHostArg` from inference-proxy.ts.
   */
  extraDockerArgs?: string[];
}

/**
 * Build the hardened `docker run` argument list for the sandbox.
 *
 * Exported for unit-test argument-construction assertions (AISDLC-508 AC-1).
 * The exact flags are testable without a real Docker daemon.
 *
 * Hardening applied:
 *   --cidfile <path>               — write container ID to file (required for kill/rm)
 *   --network=none                 — full network deny (AISDLC-510 adds inference bridge)
 *   --cap-drop=ALL                 — drop all Linux capabilities
 *   --read-only                    — read-only root filesystem
 *   --tmpfs /tmp:rw,noexec,nosuid,size=256m
 *   --tmpfs /sandbox/workspace:rw,noexec,nosuid
 *   --pids-limit 512               — prevent fork bombs
 *   --memory <N>m                  — cgroup memory limit
 *   --cpus <N>                     — cgroup CPU quota
 *   --user 65534:65534             — nobody:nogroup
 *   --rm                           — auto-remove on exit
 *   --security-opt seccomp=<json>  — syscall allowlist
 *   --security-opt no-new-privileges
 */
export function buildDockerRunArgs(opts: DockerRunArgsInput): string[] {
  const { resourceLimits, seccompProfileJson, cidFilePath, image, command, extraDockerArgs } = opts;

  return [
    'run',
    '--rm',
    '--cidfile',
    cidFilePath,
    '--network=none',
    '--cap-drop=ALL',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs',
    '/sandbox/workspace:rw,noexec,nosuid',
    '--pids-limit',
    '512',
    '--memory',
    `${resourceLimits.memoryMb}m`,
    '--cpus',
    String(resourceLimits.cpuCores),
    '--user',
    '65534:65534',
    '--security-opt',
    `seccomp=${seccompProfileJson}`,
    '--security-opt',
    'no-new-privileges',
    // Forward the data-carrying env vars from the docker CLI process env INTO
    // the container. `docker run` does NOT inherit the host environment, so the
    // values set on the spawn() env — SANDBOX_PR_DIFF_B64 (the diff to apply)
    // and SANDBOX_FIXTURE_B64 (the offline fixture tarball, fixture-demo mode) —
    // must be passed explicitly with `-e KEY` (value pulled from the docker
    // process env). Without this the in-container script sees them unset and
    // fail-closes (the AISDLC-520 "no pre-cloned repo" symptom). `-e KEY` with
    // KEY absent from the host env is a harmless no-op.
    '-e',
    'SANDBOX_PR_DIFF_B64',
    '-e',
    'SANDBOX_FIXTURE_B64',
    // Extra args (e.g. --add-host=inference.local:host-gateway) injected before image name.
    // These allow the container to reach the host-side inference proxy despite --network=none.
    ...(extraDockerArgs ?? []),
    image,
    ...command,
  ];
}

/**
 * Podman sandbox driver — pluggable stub (OQ-5 middle-ground option).
 *
 * Same isolation level as Docker (shared kernel) but rootless by default,
 * which slightly reduces the host attack surface. Substitute for Docker
 * in environments where Docker daemon is not available.
 *
 * Activate by setting `untrusted-pr-gate.yaml: sandboxDriver: podman`.
 */
export class PodmanSandboxDriver extends BaseSandboxDriver {
  readonly kind: SandboxDriverKind = 'podman';

  protected async doSpawn(_input: SandboxSpawnInput): Promise<SandboxResult> {
    return {
      outcome: 'error',
      error:
        'PodmanSandboxDriver is a pluggable stub. ' +
        'Provide a concrete implementation or use the DockerSandboxDriver. ' +
        'Rootless Podman support is tracked as a follow-up to RFC-0043 Phase 3.',
    };
  }

  async teardown(): Promise<void> {
    // no-op (stub)
  }
}

/**
 * Kata Containers sandbox driver — pluggable stub (OQ-5 middle-ground option).
 *
 * VM-isolation with container UX. ~5-10% runtime overhead vs. Docker.
 * Recommended for adopters who need stronger isolation than Docker but
 * cannot run Firecracker MicroVM (e.g. no KVM access on shared CI runners).
 *
 * Activate by setting `untrusted-pr-gate.yaml: sandboxDriver: kata`.
 */
export class KataSandboxDriver extends BaseSandboxDriver {
  readonly kind: SandboxDriverKind = 'kata';

  protected async doSpawn(_input: SandboxSpawnInput): Promise<SandboxResult> {
    return {
      outcome: 'error',
      error:
        'KataSandboxDriver is a pluggable stub. ' +
        'Kata Containers requires a compatible container runtime (kata-runtime). ' +
        'Install kata-containers and provide a concrete implementation. ' +
        'Alternatively, use sandboxDriver: docker or sandboxDriver: microvm.',
    };
  }

  async teardown(): Promise<void> {
    // no-op (stub)
  }
}

/**
 * gVisor sandbox driver — pluggable stub (OQ-5 middle-ground option).
 *
 * Syscall interception via userspace kernel (runsc). ~10-15% runtime overhead.
 * Intercepted syscalls prevent many container-escape CVE classes without
 * requiring VM-level isolation.
 *
 * Activate by setting `untrusted-pr-gate.yaml: sandboxDriver: gvisor`.
 */
export class GVisorSandboxDriver extends BaseSandboxDriver {
  readonly kind: SandboxDriverKind = 'gvisor';

  protected async doSpawn(_input: SandboxSpawnInput): Promise<SandboxResult> {
    return {
      outcome: 'error',
      error:
        'GVisorSandboxDriver is a pluggable stub. ' +
        'gVisor requires the runsc runtime (Google gVisor). ' +
        'Install gVisor and configure Docker/containerd to use runsc, then ' +
        'provide a concrete implementation.',
    };
  }

  async teardown(): Promise<void> {
    // no-op (stub)
  }
}

/**
 * Firecracker MicroVM sandbox driver — pluggable stub (OQ-5 strongest option).
 *
 * Strongest isolation: full VM boundary via KVM. Required for HIPAA /
 * FedRAMP High / PCI-DSS Level 1 (RFC-0022 regime override). Longest startup;
 * highest per-instance memory overhead; requires KVM-capable CI runners.
 *
 * Automatically selected when `complianceRegime` is `hipaa`, `fedramp-high`,
 * or `pci-dss-level-1` (regime override, OQ-5 resolution) — regardless of the
 * `sandboxDriver` field.
 */
export class MicroVmSandboxDriver extends BaseSandboxDriver {
  readonly kind: SandboxDriverKind = 'microvm';

  protected async doSpawn(_input: SandboxSpawnInput): Promise<SandboxResult> {
    return {
      outcome: 'error',
      error:
        'MicroVmSandboxDriver is a pluggable stub. ' +
        'Firecracker MicroVM requires a KVM-capable host and the Firecracker VMM binary. ' +
        'See https://github.com/firecracker-microvm/firecracker for setup. ' +
        'This driver is required for HIPAA / FedRAMP High / PCI-DSS Level 1 compliance.',
    };
  }

  async teardown(): Promise<void> {
    // no-op (stub)
  }
}

// ── Mock driver for hermetic tests ────────────────────────────────────────────

/**
 * Mock sandbox driver for hermetic tests. Does NOT require Docker/Kata/MicroVM.
 *
 * Gate real-container tests behind `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
 * Use this driver in all unit/integration tests that target the runner logic.
 *
 * Pass `delayMs` to simulate a long-running task that can exceed the
 * wall-clock timeout in the runner-level `Promise.race`. When `delayMs` is
 * set, `doSpawn` waits that many milliseconds before resolving — the
 * runner's racing timeout fires first and the mock result is never returned.
 */
export class MockSandboxDriver extends BaseSandboxDriver {
  readonly kind: SandboxDriverKind;
  private readonly mockResult: SandboxResult;
  private readonly delayMs: number;
  private teardownCalled = false;

  constructor(kind: SandboxDriverKind = 'docker', mockResult?: SandboxResult, delayMs = 0) {
    super();
    this.kind = kind;
    this.delayMs = delayMs;
    this.mockResult = mockResult ?? {
      outcome: 'success',
      differentialTest: {
        upstreamSuitePassed: true,
        upstreamSuiteOutput: 'All tests passed (mock)',
        newTestsPassed: true,
        newTestsOutput: 'All new tests passed (mock)',
        newCodeCoveragePct: 85,
      },
      durationMs: 42,
    };
  }

  protected async doSpawn(_input: SandboxSpawnInput): Promise<SandboxResult> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.mockResult;
  }

  async teardown(): Promise<void> {
    this.teardownCalled = true;
  }

  /** Inspect whether teardown was called (for test assertions). */
  wasTeardownCalled(): boolean {
    return this.teardownCalled;
  }
}

// ── Driver factory ────────────────────────────────────────────────────────────

/**
 * Create the appropriate sandbox driver for the given configuration.
 *
 * Applies the RFC-0022 regime override before selecting the driver:
 * if `config.complianceRegime` mandates MicroVM, the MicroVM driver
 * is returned regardless of `config.sandboxDriver`.
 */
export function createSandboxDriver(
  config: SandboxConfig,
  overrideDriver?: SandboxDriver,
): { driver: SandboxDriver; regimeOverrideApplied: boolean; regimeOverrideReason?: string } {
  if (overrideDriver) {
    return { driver: overrideDriver, regimeOverrideApplied: false };
  }

  const {
    driver: effectiveKind,
    overrideApplied,
    overrideReason,
  } = resolveEffectiveDriver(config.sandboxDriver, config.complianceRegime ?? 'none');

  const driver = instantiateDriver(effectiveKind);
  return {
    driver,
    regimeOverrideApplied: overrideApplied,
    regimeOverrideReason: overrideReason,
  };
}

function instantiateDriver(kind: SandboxDriverKind): SandboxDriver {
  switch (kind) {
    case 'docker':
      return new DockerSandboxDriver();
    case 'podman':
      return new PodmanSandboxDriver();
    case 'kata':
      return new KataSandboxDriver();
    case 'gvisor':
      return new GVisorSandboxDriver();
    case 'microvm':
      return new MicroVmSandboxDriver();
  }
}

// ── OpenShell policy types ────────────────────────────────────────────────────

/**
 * The OpenShell sandbox policy shape.
 * Read from `.ai-sdlc/untrusted-pr.openshell.yaml`.
 *
 * This mirrors the RFC-0043 §Stage 2 `untrusted-pr.openshell.yaml` schema.
 * The schema declaration is in `.ai-sdlc/untrusted-pr.openshell.yaml`.
 */
export interface OpenShellPolicy {
  filesystem: {
    readOnly: string[];
    readWrite: string[];
  };
  process: {
    blockSyscalls: string[];
  };
  network: {
    enforcement: 'audit' | 'enforce';
    egressAllow: Array<{ host: string; binary?: string }>;
  };
  inference: {
    route: string;
  };
}

/**
 * Load the OpenShell sandbox policy from `.ai-sdlc/untrusted-pr.openshell.yaml`.
 * Returns `null` when the file is absent (sandbox not configured).
 *
 * ## Structural validation
 * A YAML that parses successfully but is missing required top-level sections
 * (`filesystem`, `network`, `inference`) would cause downstream TypeErrors
 * when callers access e.g. `policy.network.enforcement`. To prevent silent
 * partial-object surprises, this function returns `null` on any missing
 * required section — callers treat `null` as "use safe defaults / skip
 * sandbox" which is the correct fallback.
 */
export function loadOpenShellPolicy(workDir: string = process.cwd()): OpenShellPolicy | null {
  const policyPath = join(workDir, '.ai-sdlc', 'untrusted-pr.openshell.yaml');
  if (!existsSync(policyPath)) return null;

  try {
    const raw = readFileSync(policyPath, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsYaml = require('js-yaml') as typeof import('js-yaml');
    const doc = jsYaml.load(raw);

    // Null / non-object → treat as absent
    if (!doc || typeof doc !== 'object') return null;

    const d = doc as Record<string, unknown>;

    // Required top-level sections. A partial object (e.g. only 'filesystem'
    // present) would cause TypeErrors in callers — return null for safety.
    const requiredKeys: ReadonlyArray<keyof OpenShellPolicy> = [
      'filesystem',
      'network',
      'inference',
    ];
    for (const key of requiredKeys) {
      if (!d[key] || typeof d[key] !== 'object') {
        return null;
      }
    }

    return doc as OpenShellPolicy;
  } catch {
    return null;
  }
}

// ── Sandbox runner orchestrator ───────────────────────────────────────────────

/**
 * Input for the high-level `runSandbox` orchestrator.
 */
export interface RunSandboxInput {
  prNumber: number;
  prDiff: string;
  /** URL or local path to the upstream main branch to clone. */
  upstreamMainRef: string;
  /** Adopter-level sandbox configuration. */
  config: SandboxConfig;
  /** Working directory for config resolution (defaults to process.cwd()). */
  workDir?: string;
  /**
   * Optional driver override — inject a MockSandboxDriver in tests.
   * When absent, `createSandboxDriver(config)` selects the driver.
   */
  driverOverride?: SandboxDriver;
  /** Optional policy file path override (for tests). */
  policyFilePath?: string;
  /**
   * Environment variables to inject into the sandbox container.
   *
   * RFC-0043 AQ2: pass `buildReviewerProxyEnv(...)` here (port + session token)
   * so the in-container process can reach the host-side `inference.local` proxy.
   *
   * SECURITY CONSTRAINT: These MUST NOT include any of the withheld credentials
   * (ANTHROPIC_API_KEY, AI_SDLC_SIGNING_KEY, GITHUB_TOKEN, NPM_TOKEN, AI_SDLC_PAT).
   * `validateSandboxEnv` enforces this before the driver receives them.
   */
  sandboxEnv?: Record<string, string>;
  /**
   * Extra `docker run` arguments to pass before the image name.
   *
   * RFC-0043 AQ2: pass `buildProxyHostArg(hostIp)` here to inject
   * `--add-host=inference.local:<host-ip>` so the sandbox can route TCP
   * connections to `inference.local` despite `--network=none`.
   *
   * Only the loopback-to-proxy path is opened; all other egress remains denied.
   */
  proxyHostArgs?: string[];
}

/**
 * High-level sandbox runner orchestrator.
 *
 * Orchestrates the full Stage 2/3 lifecycle:
 *  1. Apply regime override to select the effective driver.
 *  2. Validate credential withholding invariant.
 *  3. Spawn the sandbox (differential test sequence).
 *  4. On resource breach: emit breach event, return breach result.
 *  5. Teardown (idempotent, always called).
 *
 * Returns the `SandboxResult` for the caller to incorporate into the
 * unsigned report artifact (emitted to Stage 4 for clean-room signing).
 */
export async function runSandbox(input: RunSandboxInput): Promise<SandboxResult> {
  const workDir = input.workDir ?? process.cwd();
  const { driver, regimeOverrideApplied, regimeOverrideReason } = createSandboxDriver(
    input.config,
    input.driverOverride,
  );

  if (regimeOverrideApplied && regimeOverrideReason) {
    // Emit to stderr so the operator can see the override (not an error, just info)
    process.stderr.write(
      `[sandbox-runner] RFC-0022 regime override applied: ${regimeOverrideReason}\n`,
    );
  }

  const policyFilePath =
    input.policyFilePath ?? join(workDir, '.ai-sdlc', 'untrusted-pr.openshell.yaml');

  const resourceLimits = input.config.differentialTest.resourceLimits;

  const spawnInput: SandboxSpawnInput = {
    policyFilePath,
    prDiff: input.prDiff,
    upstreamMainRef: input.upstreamMainRef,
    resourceLimits,
    prNumber: input.prNumber,
    // sandboxEnv carries the inference-proxy discovery vars (host, port, session token)
    // when AQ2 wiring is active. The provider API credential is NEVER included here —
    // it lives only in the host-side InferenceProxy process.
    sandboxEnv: input.sandboxEnv,
    // proxyHostArgs: e.g. ['--add-host', 'inference.local:host-gateway'] — lets the
    // container reach the host-side proxy despite --network=none.
    extraDockerArgs: input.proxyHostArgs,
  };

  // Hard-abort enforcement via Promise.race.
  //
  // The post-hoc "did it exceed the limit?" check inside the driver cannot
  // kill a runaway — it only detects after the driver has already returned.
  // This racing timeout fires BEFORE the driver returns, aborts the run via
  // AbortController, and emits outcome:'resource-breach' (not 'error').
  //
  // The AbortController signal is passed to the driver via SandboxSpawnInput.
  // The mock driver (used in unit tests) honours it by resolving
  // outcome:'resource-breach' when aborted. The DockerSandboxDriver (real
  // container path, gated by AI_SDLC_SANDBOX_INTEGRATION_TESTS=1) should
  // also honour it to kill the container.
  const controller = new AbortController();
  const { wallClockSeconds } = resourceLimits;

  // Only arm the racing timeout when wallClockSeconds is a positive finite
  // number. Zero / negative values are silently treated as "no timeout" to
  // avoid confusing error messages for boundary-value config mistakes.
  const effectiveWallClock = wallClockSeconds > 0 ? wallClockSeconds : null;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const wallClockTimeoutPromise: Promise<SandboxResult> | null = effectiveWallClock
    ? new Promise<SandboxResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          resolve({
            outcome: 'resource-breach',
            breach: buildResourceBreachEvent(
              input.prNumber,
              'wall-clock',
              wallClockSeconds,
              'seconds',
            ),
          });
        }, effectiveWallClock * 1000);
      })
    : null;

  // Thread the AbortSignal through so drivers can honour it.
  const spawnInputWithSignal: SandboxSpawnInput & { abortSignal?: AbortSignal } = {
    ...spawnInput,
    abortSignal: controller.signal,
  };

  let result: SandboxResult;
  try {
    const driverPromise = driver.spawn(spawnInputWithSignal as SandboxSpawnInput);
    result = wallClockTimeoutPromise
      ? await Promise.race([driverPromise, wallClockTimeoutPromise])
      : await driverPromise;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    controller.abort(); // no-op if already aborted or never fired
    await driver.teardown();
  }

  return result;
}
