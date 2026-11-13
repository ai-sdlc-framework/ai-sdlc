/**
 * RFC-0043 strict AQ2 — Stage-3 reviewers execute INSIDE a proxy-only container.
 *
 * ## Network mechanism (design + justification)
 *
 * The Stage-2 differential-test container uses `--network=none` because it runs
 * untrusted code and needs zero egress. The reviewer container needs exactly ONE
 * egress: the host-side `inference.local` proxy. `--network=none` cannot express
 * that, and `--add-host` alone does not open a path. The chosen mechanism is:
 *
 *   1. A per-run user-defined bridge created with `docker network create
 *      --internal`. An internal network has no gateway and no NAT, so a
 *      container attached ONLY to it has no route to the internet or the LAN.
 *   2. A tiny relay sidecar (TCP forwarder) attached to BOTH the default
 *      bridge and the internal network, carrying the network alias
 *      `inference.local`. It forwards one fixed TCP port to the host-side
 *      proxy and nothing else.
 *   3. The reviewer container is attached to the internal network only, so
 *      the relay is the single reachable peer.
 *
 * Why not host-gateway plus an egress firewall: that needs privileged,
 * host-specific iptables rules (differs between Linux and Docker Desktop) and
 * fails open if the rules are absent. The internal network fails closed by
 * construction: no firewall state to get wrong.
 *
 * ## Verdict return
 *
 * Inputs go in through a read-only mounted directory; the verdicts come back
 * through a writable mounted directory (`verdicts.json`), parsed host-side
 * with the fail-closed parser. Container stdout is never scraped.
 *
 * ## Credential
 *
 * The container env is built from `buildReviewerProxyEnv` (discovery vars and
 * a session token only). `assertNoCredentialInEnv` refuses any env carrying a
 * withheld variable before a container is started.
 *
 * Everything that touches Docker goes through the injectable `DockerExec`
 * seam, so the contract is covered hermetically.
 *
 * @module pipeline/reviewer-container
 */

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { buildReviewerProxyEnv } from './inference-proxy.js';
import {
  validateSandboxEnv,
  DOCKER_SECCOMP_PROFILE,
  DEFAULT_SANDBOX_IMAGE,
} from './sandbox-runner.js';
import type { DifferentialTestResult } from './sandbox-runner.js';
import {
  InferenceProxyClient,
  runReviewerMatrix,
  parseReviewerResponse,
  computeConsensus,
  type SandboxGate,
} from './reviewer-runner.js';
import type { ReviewerMatrixResult } from './reviewer-runner.js';
import type { ReviewerVerdict } from './report-validator.js';

/** Alias the reviewer container resolves the proxy by. */
export const REVIEWER_PROXY_ALIAS = 'inference.local';
/** In-container mount points. */
export const REVIEWER_IN_DIR = '/sandbox/in';
export const REVIEWER_OUT_DIR = '/sandbox/out';
export const REVIEWER_APP_DIR = '/sandbox/app';
export const REVIEWER_INPUT_FILE = 'input.json';
export const REVIEWER_VERDICTS_FILE = 'verdicts.json';
/** Relay image (small, ships a TCP forwarder). */
export const DEFAULT_RELAY_IMAGE =
  'alpine/socat@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e';
/** Env var that overrides (pins) the relay image, e.g. to a digest. */
export const RELAY_IMAGE_ENV = 'AI_SDLC_REVIEWER_RELAY_IMAGE';
/** Reviewer image (needs node). */
export const DEFAULT_REVIEWER_IMAGE = DEFAULT_SANDBOX_IMAGE;

/** Result of one docker CLI invocation. */
export interface DockerExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable docker CLI executor (hermetic seam). */
export type DockerExec = (args: string[], timeoutMs?: number) => Promise<DockerExecResult>;

/** Production executor: spawns the real `docker` binary. */
export const defaultDockerExec: DockerExec = (args, timeoutMs = 600_000) =>
  new Promise((resolve) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** Names of the per-run docker resources. */
export interface ReviewerNetworkNames {
  network: string;
  relay: string;
  reviewer: string;
}

export function buildReviewerResourceNames(runId: string): ReviewerNetworkNames {
  if (!/^[a-f0-9]{8,32}$/.test(runId)) {
    throw new Error('reviewer run id must be 8-32 lowercase hex characters');
  }
  return {
    network: `ucvg-rev-net-${runId}`,
    relay: `ucvg-rev-relay-${runId}`,
    reviewer: `ucvg-rev-${runId}`,
  };
}

/** `docker network create` for the internal (no-route) network. */
export function buildInternalNetworkCreateArgs(network: string): string[] {
  return ['network', 'create', '--internal', '--driver', 'bridge', network];
}

/**
 * Relay sidecar: starts on the default bridge (it can reach the host gateway),
 * forwards the single proxy port to the host-side proxy.
 */
export function buildRelayRunArgs(opts: {
  relayName: string;
  proxyPort: number;
  image?: string;
}): string[] {
  assertPort(opts.proxyPort);
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    opts.relayName,
    '--cap-drop=ALL',
    '--read-only',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--add-host',
    'host.docker.internal:host-gateway',
    opts.image ?? DEFAULT_RELAY_IMAGE,
    `TCP-LISTEN:${String(opts.proxyPort)},fork,reuseaddr`,
    `TCP:host.docker.internal:${String(opts.proxyPort)}`,
  ];
}

/** Attach the relay to the internal network under the `inference.local` alias. */
export function buildRelayConnectArgs(network: string, relayName: string): string[] {
  return ['network', 'connect', '--alias', REVIEWER_PROXY_ALIAS, network, relayName];
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid proxy port: ${String(port)}`);
  }
}

/** Provider-credential names that must never reach the reviewer container. */
const PROVIDER_CREDENTIAL_KEY = /(API_KEY|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Refuse an env that carries a withheld or provider credential variable. */
export function assertNoCredentialInEnv(env: Record<string, string>): void {
  validateSandboxEnv(env);
  for (const key of Object.keys(env)) {
    if (PROVIDER_CREDENTIAL_KEY.test(key)) {
      throw new Error(`reviewer container env must not carry credential variable ${key}`);
    }
  }
}

export interface ReviewerContainerArgsInput {
  name: string;
  network: string;
  inDir: string;
  outDir: string;
  appDir: string;
  /** Path to a seccomp profile FILE (docker does not accept inline JSON). */
  seccompProfilePath: string;
  env: Record<string, string>;
  image?: string;
  memoryMb?: number;
  cpuCores?: number;
}

/**
 * Hardened `docker run` args for the reviewer container. Unlike the Stage-2
 * container this attaches to the internal network (never the default bridge,
 * never host networking) and mounts a writable verdict directory.
 */
export function buildReviewerContainerArgs(opts: ReviewerContainerArgsInput): string[] {
  assertNoCredentialInEnv(opts.env);
  const envFlags = Object.keys(opts.env)
    .sort()
    .flatMap((k) => ['-e', `${k}=${opts.env[k]}`]);
  return [
    'run',
    '--rm',
    '--name',
    opts.name,
    `--network=${opts.network}`,
    '--cap-drop=ALL',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--pids-limit',
    '256',
    '--memory',
    `${opts.memoryMb ?? 1024}m`,
    '--cpus',
    String(opts.cpuCores ?? 1),
    '--user',
    '65534:65534',
    '--security-opt',
    `seccomp=${opts.seccompProfilePath}`,
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${opts.inDir}:${REVIEWER_IN_DIR}:ro`,
    '-v',
    `${opts.appDir}:${REVIEWER_APP_DIR}:ro`,
    '-v',
    `${opts.outDir}:${REVIEWER_OUT_DIR}:rw`,
    ...envFlags,
    opts.image ?? DEFAULT_REVIEWER_IMAGE,
    ...REVIEWER_ENTRYPOINT_COMMAND,
  ];
}

/** Container command: loads the mounted build and runs the entrypoint. */
export const REVIEWER_ENTRYPOINT_COMMAND: readonly string[] = [
  'node',
  '--input-type=module',
  '-e',
  `import(${JSON.stringify(`${REVIEWER_APP_DIR}/pipeline/reviewer-container.js`)}).then((m) => m.runReviewerEntrypoint())`,
];

// ── In-container entrypoint ───────────────────────────────────────────────────

/** Input document the host stages for the container. */
export interface ReviewerContainerInput {
  prDiff: string;
  prNumber: number;
  differentialTest: DifferentialTestResult;
}

/**
 * Runs inside the container: reads the staged input, runs the reviewer matrix
 * through the proxy client, writes `verdicts.json` to the mounted out dir.
 */
export async function runReviewerEntrypoint(
  env: NodeJS.ProcessEnv = process.env,
  dirs: { inDir: string; outDir: string } = { inDir: REVIEWER_IN_DIR, outDir: REVIEWER_OUT_DIR },
  makeClient: (cfg: {
    host: string;
    port: number;
    sessionToken: string;
  }) => InferenceProxyClient = (cfg) => new InferenceProxyClient(cfg),
): Promise<void> {
  const host = env['INFERENCE_PROXY_HOST'];
  const port = parseInt(env['INFERENCE_PROXY_PORT'] ?? '0', 10);
  const sessionToken = env['INFERENCE_PROXY_SESSION'];
  if (!host || !(port > 0) || !sessionToken) {
    throw new Error('reviewer entrypoint: proxy discovery env vars are missing');
  }
  const input = JSON.parse(
    readFileSync(join(dirs.inDir, REVIEWER_INPUT_FILE), 'utf8'),
  ) as ReviewerContainerInput;
  const result = await runReviewerMatrix({
    prDiff: input.prDiff,
    prNumber: input.prNumber,
    differentialTest: input.differentialTest,
    modelClient: makeClient({ host, port, sessionToken }),
  });
  writeFileSync(join(dirs.outDir, REVIEWER_VERDICTS_FILE), JSON.stringify(result.verdicts));
}

// ── Host-side orchestration ───────────────────────────────────────────────────

/**
 * Parse the verdict file host-side. Fail-closed: a missing/corrupt file or a
 * missing role yields a rejecting verdict, never an approval.
 */
export function readReviewerVerdicts(outDir: string, sandbox: SandboxGate): ReviewerMatrixResult {
  const file = join(outDir, REVIEWER_VERDICTS_FILE);
  let parsed: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const one = (role: string): ReviewerVerdict =>
    parseReviewerResponse(parsed[role] === undefined ? '' : JSON.stringify(parsed[role]));
  const verdicts = { code: one('code'), test: one('test'), security: one('security') };
  return { verdicts, consensus: computeConsensus(verdicts, sandbox) };
}

export interface RunReviewerInContainerInput {
  prDiff: string;
  prNumber: number;
  differentialTest: DifferentialTestResult;
  /** Host-side proxy port and session token (never the provider key). */
  proxyPort: number;
  sessionToken: string;
  /** Directory holding the compiled pipeline modules (mounted read-only). */
  appDir: string;
  exec?: DockerExec;
  runId?: string;
  relayImage?: string;
  reviewerImage?: string;
  /** Override for the model-id module shimmed in as `@ai-sdlc/reference`. */
  modelIdsFile?: string;
  /** Parent for the isolated scratch dir. Defaults to the OS tmpdir. */
  scratchParent?: string;
}

/**
 * Stage a self-contained app dir: a copy of the compiled pipeline-cli dist plus
 * a minimal `@ai-sdlc/reference` shim (only the dependency-free model-id
 * module), so the node:22-slim container needs no node_modules.
 */
export function stageReviewerApp(distDir: string, scratch: string, modelIdsFile?: string): string {
  const appDir = join(scratch, 'app');
  cpSync(distDir, appDir, { recursive: true });
  const modelIds =
    modelIdsFile ??
    join(
      dirname(fileURLToPath(import.meta.resolve('@ai-sdlc/reference'))),
      'models',
      'claude-model-ids.js',
    );
  const shimDir = join(appDir, 'node_modules', '@ai-sdlc', 'reference');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(
    join(shimDir, 'package.json'),
    JSON.stringify({ name: '@ai-sdlc/reference', type: 'module', main: 'index.js' }),
  );
  writeFileSync(join(shimDir, 'index.js'), readFileSync(modelIds));
  return appDir;
}

/**
 * Create the pinhole network and relay, run the reviewers in the container,
 * read verdicts from the mounted volume, and always tear everything down.
 */
export async function runReviewerMatrixInContainer(
  input: RunReviewerInContainerInput,
): Promise<ReviewerMatrixResult> {
  const exec = input.exec ?? defaultDockerExec;
  const names = buildReviewerResourceNames(input.runId ?? randomBytes(8).toString('hex'));
  const scratch = mkdtempSync(join(input.scratchParent ?? tmpdir(), 'ucvg-reviewer-'));
  const inDir = join(scratch, 'in');
  const outDir = join(scratch, 'out');
  mkdirSync(inDir);
  // The container runs as nobody; the out dir must be writable by it.
  mkdirSync(outDir, { mode: 0o777 });
  // mkdirSync's mode is masked by the umask; chmod explicitly.
  chmodSync(outDir, 0o777);
  const seccompProfilePath = join(scratch, 'seccomp.json');
  writeFileSync(seccompProfilePath, JSON.stringify(DOCKER_SECCOMP_PROFILE), { mode: 0o600 });
  const doc: ReviewerContainerInput = {
    prDiff: input.prDiff,
    prNumber: input.prNumber,
    differentialTest: input.differentialTest,
  };
  writeFileSync(join(inDir, REVIEWER_INPUT_FILE), JSON.stringify(doc));

  const created: { network: boolean; relay: boolean } = { network: false, relay: false };
  try {
    const appDir = stageReviewerApp(input.appDir, scratch, input.modelIdsFile);
    const env = buildReviewerProxyEnv({ port: input.proxyPort, sessionToken: input.sessionToken });
    const runArgs = buildReviewerContainerArgs({
      name: names.reviewer,
      network: names.network,
      inDir,
      outDir,
      appDir,
      seccompProfilePath,
      env,
      image: input.reviewerImage,
    });
    const net = await exec(buildInternalNetworkCreateArgs(names.network));
    if (net.code !== 0) throw new Error('reviewer network creation failed');
    created.network = true;

    const relay = await exec(
      buildRelayRunArgs({
        relayName: names.relay,
        proxyPort: input.proxyPort,
        image: input.relayImage ?? process.env[RELAY_IMAGE_ENV] ?? DEFAULT_RELAY_IMAGE,
      }),
    );
    if (relay.code !== 0) throw new Error('reviewer relay start failed');
    created.relay = true;

    const connect = await exec(buildRelayConnectArgs(names.network, names.relay));
    if (connect.code !== 0) throw new Error('reviewer relay attach failed');

    // The exit code is advisory; the verdict file is authoritative and parsed
    // fail-closed, so a crashed container yields rejecting verdicts.
    await exec(runArgs);
    return readReviewerVerdicts(outDir, input.differentialTest);
  } catch (err) {
    process.stderr.write(`[reviewer-container] ${(err as Error).message}; failing closed\n`);
    return readReviewerVerdicts(outDir, input.differentialTest);
  } finally {
    if (created.relay) await exec(['rm', '-f', names.relay]);
    await exec(['rm', '-f', names.reviewer]);
    if (created.network) await exec(['network', 'rm', names.network]);
    rmSync(scratch, { recursive: true, force: true });
  }
}
