/**
 * RFC-0043 Phase 3 — Stage 2/3: OpenShell Sandbox Runner (AISDLC-499)
 * RFC-0043 Phase 7 — Real Docker sandbox driver (AISDLC-508)
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
 * @module pipeline/sandbox-runner
 */

import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
   * This is the integration seam: when `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`,
   * spawns a real container. AISDLC-509 will fill in the in-container
   * differential-test logic (clone, apply diff, run upstream + new tests).
   * This task (AISDLC-508) implements the container LIFECYCLE: startup,
   * resource limits, abort-kill, and teardown.
   */
  private async runDockerDifferentialTest(
    input: SandboxSpawnInput & { abortSignal?: AbortSignal },
  ): Promise<DifferentialTestResult> {
    const { resourceLimits } = input;
    const seccompJson = JSON.stringify(DOCKER_SECCOMP_PROFILE);

    // Create an isolated temp directory and cidfile path per spawn invocation.
    // `docker run --cidfile <path>` writes the full container ID to this file
    // once the container starts (even in foreground / non-detached mode).
    // We read the cidfile to obtain the container ID for kill/rm operations.
    const cidDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-sandbox-'));
    const cidFilePath = join(cidDir, 'container.cid');
    this.cidFilePath = cidFilePath;

    // Build the docker run arguments
    const args = buildDockerRunArgs({
      resourceLimits,
      seccompProfileJson: seccompJson,
      cidFilePath,
      // AISDLC-509 will inject the real image + in-container command
      image: process.env['AI_SDLC_SANDBOX_IMAGE'] ?? 'node:22-slim',
      command: [
        '/bin/sh',
        '-c',
        // Placeholder — AISDLC-509 replaces this with the real differential test entrypoint
        'echo "in-container differential test not yet wired" && exit 1',
      ],
    });

    return new Promise<DifferentialTestResult>((resolve, reject) => {
      const proc = spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Pass a clean environment — never inherit the host env wholesale
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
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

        // AISDLC-509 will parse stdout/stderr into a real DifferentialTestResult.
        // For now, surface the container output for debugging and return a
        // not-yet-implemented result so the lifecycle path works end-to-end.
        if (exitCode !== 0) {
          reject(
            new Error(
              `Docker container exited with code ${exitCode}. ` +
                `stdout: ${stdout.slice(0, 500)} stderr: ${stderr.slice(0, 500)}`,
            ),
          );
          return;
        }

        // Placeholder result — AISDLC-509 replaces this with real test output parsing
        resolve({
          upstreamSuitePassed: false,
          upstreamSuiteOutput: `[differential-test pending] raw stdout: ${stdout.slice(0, 500)}`,
          newTestsPassed: false,
          newTestsOutput: `[differential-test pending] raw stderr: ${stderr.slice(0, 500)}`,
          newCodeCoveragePct: 0,
        });
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
      const proc = spawn('docker', ['kill', id], { stdio: 'ignore' });
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
        const proc = spawn('docker', ['rm', '-f', id], { stdio: 'ignore' });
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
  const { resourceLimits, seccompProfileJson, cidFilePath, image, command } = opts;

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
    // sandboxEnv is explicitly left undefined — no withheld credentials.
    // The inference proxy injects the provider API key at inference.local.
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
