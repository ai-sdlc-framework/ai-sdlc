/**
 * AISDLC-1278 — run an untrusted developer agent inside a container.
 *
 * AISDLC-1277 removed the credentials an untrusted agent inherits. The agent still
 * ran as the maintainer's OS user, so it could read any file that user can read and
 * reach any network host. For an untrusted spawn the agent now runs in a container
 * that sees ONE host path (the task worktree) and reaches ONE network peer (a relay
 * to the pipeline's model proxy, over a per-run `--internal` network with no route
 * out). The pipeline process stays on the host and does the rebase, push and PR.
 *
 * Everything that touches Docker goes through the injectable `DockerExec`; the
 * proxy start goes through `startProxy`. Both are hermetic in tests.
 *
 * @module runtime/untrusted-container
 */

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  InferenceProxy,
  buildReviewerProxyEnv,
  type InferenceProxyConfig,
} from '../pipeline/inference-proxy.js';
import { DEFAULT_SANDBOX_IMAGE } from '../pipeline/sandbox-runner.js';
import {
  buildInternalNetworkCreateArgs,
  buildRelayConnectArgs,
  buildRelayRunArgs,
  defaultDockerExec,
  DEFAULT_RELAY_IMAGE,
  RELAY_IMAGE_ENV,
  type DockerExec,
} from '../pipeline/reviewer-container.js';
import type { Runner } from './exec.js';
import type { SubagentSpawner } from '../types.js';

/** In-container path of the task worktree (the only host mount). */
export const UNTRUSTED_WORKSPACE_DIR = '/workspace';
/** Env var that overrides the agent image; must be a digest reference. */
export const UNTRUSTED_AGENT_IMAGE_ENV = 'AI_SDLC_UNTRUSTED_AGENT_IMAGE';
/** Default agent image (digest-pinned). The image must provide the `claude` CLI. */
export const DEFAULT_UNTRUSTED_AGENT_IMAGE = DEFAULT_SANDBOX_IMAGE;
/** Container runtime the pipeline drives. */
export const CONTAINER_RUNTIME = 'docker';

const DIGEST_REF = /@sha256:[a-f0-9]{64}$/;
const CREDENTIAL_ENV_KEY = /(_TOKEN|_KEY|_SECRET)$|^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/i;

/** Refuse a non-digest image reference. */
export function assertDigestImage(image: string): void {
  if (!DIGEST_REF.test(image)) {
    throw new Error(
      `untrusted agent image must be pinned by digest (name@sha256:<64 hex>): ${image}`,
    );
  }
}

/** Refuse a container env carrying a model credential, `*_TOKEN`, `*_KEY` or `*_SECRET`. */
export function assertNoCredentialEnv(env: Record<string, string>): void {
  for (const k of Object.keys(env)) {
    if (CREDENTIAL_ENV_KEY.test(k)) {
      throw new Error(`untrusted container env must not carry credential variable ${k}`);
    }
  }
}

/** The proxy may only bind loopback (IPv4 127/8, `::1`, `localhost`). */
export function assertProxyBindAddress(addr: string): void {
  const ok = /^127(\.\d{1,3}){3}$/.test(addr) || addr === '::1' || addr === 'localhost';
  if (!ok) {
    throw new Error(`inference proxy for an untrusted run must bind loopback, not ${addr}`);
  }
}

export interface UntrustedResourceNames {
  network: string;
  relay: string;
  agent: string;
}

export function buildUntrustedResourceNames(runId: string): UntrustedResourceNames {
  if (!/^[a-f0-9]{8,32}$/.test(runId)) {
    throw new Error('untrusted run id must be 8-32 lowercase hex characters');
  }
  return {
    network: `ucvg-ua-net-${runId}`,
    relay: `ucvg-ua-relay-${runId}`,
    agent: `ucvg-ua-${runId}`,
  };
}

/** Env for the container: signal keys, a tmpfs HOME, git hardening and proxy discovery. */
export function buildUntrustedContainerEnv(
  optsEnv: NodeJS.ProcessEnv | undefined,
  proxy: { port: number; sessionToken: string },
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: '/home/agent',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...buildReviewerProxyEnv(proxy),
  };
  for (const [k, v] of Object.entries(optsEnv ?? {})) {
    if (k.startsWith('AI_SDLC_') && v !== undefined) env[k] = v;
  }
  assertNoCredentialEnv(env);
  return env;
}

export interface UntrustedContainerArgsInput {
  name: string;
  network: string;
  /** Absolute host path of the task worktree: the one mount. */
  worktree: string;
  env: Record<string, string>;
  image: string;
  /** Command run in the container (the `claude` argv). */
  command: readonly string[];
}

/** Hardened `docker run` args: one mount, internal network, digest image, no credentials. */
export function buildUntrustedContainerArgs(input: UntrustedContainerArgsInput): string[] {
  assertDigestImage(input.image);
  assertNoCredentialEnv(input.env);
  if (!isAbsolute(input.worktree) || /[:,\n]/.test(input.worktree)) {
    throw new Error(`untrusted worktree mount path is not usable: ${input.worktree}`);
  }
  const envFlags = Object.keys(input.env)
    .sort()
    .flatMap((k) => ['-e', `${k}=${input.env[k]}`]);
  return [
    'run',
    '--rm',
    '--name',
    input.name,
    `--network=${input.network}`,
    '--cap-drop=ALL',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs',
    '/home/agent:rw,nosuid,size=64m',
    '--pids-limit',
    '512',
    '--memory',
    '4096m',
    '--cpus',
    '2',
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${input.worktree}:${UNTRUSTED_WORKSPACE_DIR}:rw`,
    '-w',
    UNTRUSTED_WORKSPACE_DIR,
    ...envFlags,
    input.image,
    ...input.command,
  ];
}

/** Handle to a started host-side model proxy. */
export interface ProxyHandle {
  port: number;
  sessionToken: string;
  bindAddress: string;
  stop: () => Promise<void>;
}

/** Start the host-side proxy on loopback with the pipeline's own credential. */
export const defaultStartProxy = async (): Promise<ProxyHandle> => {
  const credential = process.env.ANTHROPIC_API_KEY;
  if (!credential) {
    throw new Error('untrusted run needs a model credential on the pipeline host for the proxy');
  }
  const bindAddress = '127.0.0.1';
  const config: InferenceProxyConfig = {
    prNumber: 0,
    credential,
    useHttp: true,
    bindAddress,
    agentSession: true,
    limits: {
      maxRequestsPerSession: 5000,
      maxBodyBytes: 8 * 1024 * 1024,
      maxResponseBytes: 64 * 1024 * 1024,
    },
  };
  const proxy = new InferenceProxy(config);
  const { port, sessionToken } = await proxy.start();
  return { port, sessionToken, bindAddress, stop: () => proxy.stop() };
};

export interface UntrustedContainerOptions {
  exec?: DockerExec;
  startProxy?: () => Promise<ProxyHandle>;
  image?: string;
  runId?: string;
}

export interface ContainerLaunch {
  binary: string;
  args: string[];
}

/**
 * Prepare network, relay and proxy, run `fn` with the `docker run` launch, and always
 * tear everything down. Returns `{ error }` (no launch happened) when no container
 * runtime is available or setup fails.
 */
export async function withUntrustedContainer<T>(
  container: UntrustedContainerOptions,
  input: { worktree: string; optsEnv: NodeJS.ProcessEnv | undefined; command: readonly string[] },
  fn: (launch: ContainerLaunch) => Promise<T>,
): Promise<{ error: string } | { value: T }> {
  const exec = container.exec ?? defaultDockerExec;
  const probe = await exec(['version', '--format', '{{.Server.Version}}'], 15_000);
  if (probe.code !== 0) {
    return {
      error:
        `untrusted run requires a container runtime (${CONTAINER_RUNTIME}), which is not available ` +
        `(${(probe.stderr || 'no output').trim().slice(0, 200)}). No agent was started.`,
    };
  }
  const names = buildUntrustedResourceNames(container.runId ?? randomBytes(8).toString('hex'));
  const image =
    container.image ?? process.env[UNTRUSTED_AGENT_IMAGE_ENV] ?? DEFAULT_UNTRUSTED_AGENT_IMAGE;
  const created = { network: false, relay: false, agent: false };
  let proxy: ProxyHandle | null = null;
  try {
    proxy = await (container.startProxy ?? defaultStartProxy)();
    assertProxyBindAddress(proxy.bindAddress);
    const args = buildUntrustedContainerArgs({
      name: names.agent,
      network: names.network,
      worktree: input.worktree,
      env: buildUntrustedContainerEnv(input.optsEnv, proxy),
      image,
      command: input.command,
    });
    const net = await exec(buildInternalNetworkCreateArgs(names.network));
    if (net.code !== 0) throw new Error('internal network creation failed');
    created.network = true;
    const relay = await exec(
      buildRelayRunArgs({
        relayName: names.relay,
        proxyPort: proxy.port,
        image: process.env[RELAY_IMAGE_ENV] ?? DEFAULT_RELAY_IMAGE,
      }),
    );
    if (relay.code !== 0) throw new Error('proxy relay start failed');
    created.relay = true;
    const connect = await exec(buildRelayConnectArgs(names.network, names.relay));
    if (connect.code !== 0) throw new Error('proxy relay attach failed');
    created.agent = true;
    return { value: await fn({ binary: CONTAINER_RUNTIME, args }) };
  } catch (err) {
    return { error: `untrusted container setup failed: ${(err as Error).message}` };
  } finally {
    if (created.agent) await exec(['rm', '-f', names.agent]);
    if (created.relay) await exec(['rm', '-f', names.relay]);
    if (created.network) await exec(['network', 'rm', names.network]);
    if (proxy) await proxy.stop().catch(() => undefined);
  }
}

// ── Host-side git hardening (Steps 10 and 11) ─────────────────────────────────

/**
 * `-c` overrides that stop the host's git calls from running code the agent chose
 * through the worktree's git config or tree. Hooks are off entirely: the main
 * checkout's hooks run worktree-relative scripts the agent can edit, so the gates run
 * in CI against the pushed tree instead. Signing programs, fsmonitor, the ssh command,
 * attribute files and external transports are pinned.
 */
export function hostGitOverrides(): string[] {
  return [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.sshCommand=ssh',
    'core.attributesFile=/dev/null',
    'commit.gpgsign=false',
    'tag.gpgsign=false',
    'gpg.program=false',
    'protocol.ext.allow=never',
  ].flatMap((o) => ['-c', o]);
}

/**
 * The worktree's `.git` file sits inside the read-write mount, so the agent can repoint
 * it at a git dir it built (with its own config, filters and helpers). Refuse to run any
 * host git call unless it still points at `<main>/.git/worktrees/<name>`.
 */
export function assertWorktreeGitdir(worktree: string, mainCheckout: string): void {
  let raw: string;
  try {
    raw = readFileSync(join(worktree, '.git'), 'utf8');
  } catch {
    throw new Error(`untrusted run: ${worktree}/.git is missing or not a worktree gitdir file`);
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  const expectedRoot = join(realpathOr(mainCheckout), '.git', 'worktrees') + sep;
  const target = m ? resolve(worktree, m[1]) : '';
  if (!m || !(realpathOr(target) + sep).startsWith(expectedRoot)) {
    throw new Error(
      `untrusted run: the worktree .git file no longer points under ${expectedRoot}; refusing to run git on it`,
    );
  }
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Wrap a runner so every `git` call carries `hostGitOverrides`. Other commands pass through. */
export function hardenGitRunner(inner: Runner): Runner {
  const overrides = hostGitOverrides();
  return (command, args, opts) => {
    if (command !== 'git') return inner(command, args, opts);
    // `diff.external` and textconv drivers run programs; refuse them on every host diff.
    const safe =
      args[0] === 'diff'
        ? [
            'diff',
            ...['--no-ext-diff', '--no-textconv'].filter((f) => !args.includes(f)),
            ...args.slice(1),
          ]
        : args;
    return inner(command, [...overrides, ...safe], opts);
  };
}

/**
 * Wrap a spawner so the worktree gitdir is re-verified after every spawn returns (also
 * when it throws), before the caller runs any host git call against the worktree.
 */
export function withGitdirCheck(
  inner: SubagentSpawner,
  getWorktree: () => string | null,
  mainCheckout: string,
): SubagentSpawner {
  const check = (): void => {
    const wt = getWorktree();
    if (wt) assertWorktreeGitdir(wt, mainCheckout);
  };
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    let out: T;
    try {
      out = await run();
    } catch (err) {
      check();
      throw err;
    }
    check();
    return out;
  };
  return {
    spawn: (o) => guard(() => inner.spawn(o)),
    spawnParallel: (os) => guard(() => inner.spawnParallel(os)),
  };
}

// ── Dependency manifest limit ─────────────────────────────────────────────────

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  '.npmrc',
  '.yarnrc.yml',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
]);

/** True for a dependency manifest or lockfile path. */
export function isDependencyManifest(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return MANIFEST_BASENAMES.has(base) || /^requirements.*\.txt$/.test(base);
}

/**
 * Throw when the run's diff (committed against `origin/main`, or uncommitted) changes
 * a dependency manifest or lockfile. An untrusted run must not change what gets installed.
 */
export async function assertNoDependencyChange(runner: Runner, worktree: string): Promise<void> {
  const files = new Set<string>();
  const committed = await runner(
    'git',
    ['diff', '--name-only', '--no-renames', 'origin/main...HEAD'],
    {
      cwd: worktree,
      allowFailure: true,
    },
  );
  if (committed.code !== 0) {
    throw new Error('untrusted run: could not list committed changes; stopping before push.');
  }
  for (const f of committed.stdout.split('\n')) if (f.trim()) files.add(f.trim());
  const status = await runner('git', ['status', '--porcelain', '-uall', '-z'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (status.code !== 0) {
    throw new Error('untrusted run: could not read worktree status; stopping before push.');
  }
  const entries = status.stdout.split('\0').filter((e) => e !== '');
  for (let i = 0; i < entries.length; i++) {
    files.add(entries[i].slice(3));
    // A rename or copy entry is followed by its origin path.
    if (/^[RC]/.test(entries[i]) || /^.[RC]/.test(entries[i])) {
      const origin = entries[++i];
      if (origin) files.add(origin);
    }
  }
  const hit = [...files].find(isDependencyManifest);
  if (hit) {
    throw new Error(
      `untrusted run changed dependency file ${hit}; a run from outside input may not change dependencies. Stopping before push.`,
    );
  }
}
