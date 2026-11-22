/**
 * The `gh webhook forward` feed as a supervised launchd agent (AISDLC-1207). `webhook up
 * --feed gh-forward` installs the agent (KeepAlive), after deleting stale `cli` hooks that a
 * forwarder dying uncleanly leaves behind (`HTTP 422 Hook already exists`). Liveness is read
 * from the agent label, never from a recorded pid. Non-macOS: the command is printed.
 */

import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HierarchyDeps } from './types.js';

export const FORWARDER_LABEL_PREFIX = 'com.ai-sdlc.webhook';
export const FORWARD_EVENTS =
  'pull_request,check_suite,check_run,workflow_run,status,pull_request_review';

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0);

/**
 * The launchd label, one per project so two projects never collide (AISDLC-1256):
 * `com.ai-sdlc.webhook.<project-slug>`, the slug being the board dir's name plus a short hash
 * of its absolute path.
 */
export function forwarderLabel(deps: HierarchyDeps): string {
  const abs = path.resolve(deps.boardDir);
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  const name = path
    .basename(abs)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${FORWARDER_LABEL_PREFIX}.${name ? `${name}-` : ''}${hash}`;
}

export const agentDomain = (label: string): string => `gui/${uid()}/${label}`;

export function forwarderPlistPath(deps: HierarchyDeps, label = forwarderLabel(deps)): string {
  const home = deps.env.HOME || os.homedir();
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/** Raised when launchd refuses the agent: the feed is not persisted. */
export class ForwarderPersistError extends Error {}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The forwarder argv; `--secret` is the receiver's secret so deliveries verify. */
export function forwarderArgs(repo: string, port: number, secret: string): string[] {
  return [
    'gh',
    'webhook',
    'forward',
    '--repo',
    repo,
    '--events',
    FORWARD_EVENTS,
    '--url',
    `http://127.0.0.1:${port}/webhooks/github`,
    '--secret',
    secret,
  ];
}

const defaultExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/** Any board's `gh` wrapper directory (`<repo>/.ai-sdlc/dispatch/bin`), not only this board's own. */
const isBoardWrapperDir = (d: string): boolean =>
  /(^|[\\/])\.ai-sdlc[\\/]dispatch[\\/]bin$/.test(path.resolve(d));

/** The session PATH without the board's `bin/` directory (it holds the `gh` call-counting wrapper). */
export function agentPath(deps: HierarchyDeps): string {
  const bin = path.join(deps.boardDir, 'bin');
  const entries = (deps.env.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d && !sameDir(d, bin) && !isBoardWrapperDir(d));
  return entries.length > 0
    ? entries.join(path.delimiter)
    : '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
}

/** Absolute path of the real `gh` (never the board's wrapper); throws when there is none. */
export function resolveRealGh(deps: HierarchyDeps): string {
  const exec = deps.isExecutable ?? defaultExecutable;
  for (const d of agentPath(deps).split(path.delimiter)) {
    const candidate = path.join(d, 'gh');
    if (exec(candidate)) return candidate;
  }
  throw new Error(
    `cannot find the real gh: the only gh on PATH is the board's wrapper (${path.join(deps.boardDir, 'bin')}) or none is installed; install gh (https://cli.github.com) in a directory outside the repository`,
  );
}

export function renderPlist(
  args: string[],
  logPath: string,
  envPath: string,
  label: string,
): string {
  const argv = args.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(envPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** `owner/repo` of the checkout, from `gh repo view`. */
export function resolveRepo(deps: HierarchyDeps): string {
  const r = deps.run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: deps.cwd,
  });
  const repo = (r?.stdout ?? '').trim();
  if (r?.status !== 0 || !repo) throw new Error('cannot resolve the repository (gh repo view)');
  return repo;
}

/**
 * Delete the `cli` hooks `gh webhook forward` creates; hooks of any other name are left alone.
 * Returns the number deleted.
 */
export function deleteStaleCliHooks(deps: HierarchyDeps, repo: string): number {
  const r = deps.run('gh', ['api', `repos/${repo}/hooks`, '--paginate'], { cwd: deps.cwd });
  if (r?.status !== 0) return 0;
  let hooks: { id?: number; name?: string }[];
  try {
    const parsed = JSON.parse(r.stdout || '[]');
    hooks = Array.isArray(parsed) ? parsed : [];
  } catch {
    return 0;
  }
  let n = 0;
  for (const h of hooks) {
    if (h.name !== 'cli' || typeof h.id !== 'number') continue;
    const d = deps.run('gh', ['api', '-X', 'DELETE', `repos/${repo}/hooks/${h.id}`], {
      cwd: deps.cwd,
    });
    if (d?.status === 0) n += 1;
  }
  return n;
}

export interface AgentState {
  loaded: boolean;
  /** launchd has the job running (`state = running`). */
  running: boolean;
  state?: string;
  lastExit?: string;
  stderr?: string;
}

/** Read `launchctl print`: loaded is not running (a crash-looping job is loaded, AISDLC-1285). */
export function forwarderAgentState(deps: HierarchyDeps, label = forwarderLabel(deps)): AgentState {
  try {
    const r = deps.run('launchctl', ['print', agentDomain(label)], { cwd: deps.cwd });
    if (r?.status !== 0) return { loaded: false, running: false, stderr: r?.stderr ?? '' };
    const out = r.stdout ?? '';
    const state = /^\s*state = (.+)$/m.exec(out)?.[1]?.trim();
    const lastExit = /^\s*last exit code = (.+)$/m.exec(out)?.[1]?.trim();
    return {
      loaded: true,
      running: state === undefined || state === 'running',
      ...(state ? { state } : {}),
      ...(lastExit ? { lastExit } : {}),
    };
  } catch {
    return { loaded: false, running: false };
  }
}

/** Whether launchd has the agent running, not merely loaded. */
export function forwarderAgentAlive(deps: HierarchyDeps, label = forwarderLabel(deps)): boolean {
  return forwarderAgentState(deps, label).running;
}

const describeNotRunning = (a: AgentState): string =>
  `state = ${a.state ?? 'unknown'}${a.lastExit ? `, last exit code = ${a.lastExit}` : ''}`;

/** `loaded, not running (last exit 126)`: the status reading of a crash-looping job (AISDLC-1299). */
export const describeLoadedNotRunning = (a: AgentState): string =>
  `loaded, not running (${a.lastExit ? `last exit ${a.lastExit}` : `state ${a.state ?? 'unknown'}`})`;

/** `persisted: launchd <label>` or `persisted: no (<reason>)`, from `launchctl print`. */
export function forwarderPersistence(
  deps: HierarchyDeps,
  label = forwarderLabel(deps),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'darwin') return 'persisted: no (no launchd on this platform)';
  try {
    const a = forwarderAgentState(deps, label);
    if (a.loaded && a.running) return `persisted: launchd ${label}`;
    if (a.loaded) return `persisted: no (${label} ${describeLoadedNotRunning(a)})`;
    return `persisted: no (${label} not installed)`;
  } catch {
    return `persisted: no (launchctl unavailable)`;
  }
}

/**
 * Install and load the agent. Returns true when launchd manages it; false (command printed)
 * on a platform without launchd. Throws when the secret is missing
 * and a ForwarderPersistError when launchd refuses the agent twice.
 */
export function installForwarder(
  deps: HierarchyDeps,
  secret: string | undefined,
  port: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!secret) throw new Error('AI_SDLC_WEBHOOK_SECRET is not set: the hook secret must match it');
  const repo = resolveRepo(deps);
  const args = forwarderArgs(repo, port, secret);
  if (platform !== 'darwin') {
    deps.log(
      `no launchd here: run the forwarder under your own supervisor (systemd, a restart loop):\n  ${args
        .slice(0, -1)
        .join(' ')} --secret "$AI_SDLC_WEBHOOK_SECRET"`,
    );
    return false;
  }
  args[0] = resolveRealGh(deps);
  const removed = deleteStaleCliHooks(deps, repo);
  if (removed > 0) deps.log(`removed ${removed} stale cli hook(s) on ${repo}`);
  const label = forwarderLabel(deps);
  const plist = forwarderPlistPath(deps, label);
  mkdirSync(path.dirname(plist), { recursive: true });
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(
    plist,
    renderPlist(args, path.join(deps.boardDir, 'webhook-forward.log'), agentPath(deps), label),
    { mode: 0o600 },
  );
  const dom = agentDomain(label);
  deps.run('launchctl', ['bootout', dom], { cwd: deps.cwd });
  const boot = (): ReturnType<HierarchyDeps['run']> =>
    deps.run('launchctl', ['bootstrap', `gui/${uid()}`, plist], { cwd: deps.cwd });
  let r = boot();
  // Error 5 (Input/output error): a same-label job is still loaded or the plist path moved.
  if (r?.status !== 0 && /Bootstrap failed: 5/.test(r?.stderr ?? '')) {
    deps.run('launchctl', ['bootout', dom], { cwd: deps.cwd });
    r = boot();
  }
  if (r?.status !== 0) {
    throw new ForwarderPersistError(
      `launchctl bootstrap failed, the forwarder is NOT persisted:\n${(r?.stderr ?? '').trim()}\n` +
        `plist: ${plist}\nrecover manually:\n  launchctl bootout ${dom}\n  launchctl bootstrap gui/${uid()} ${plist}`,
    );
  }
  // Loaded is not alive: give the job a moment, then require launchd to have it running.
  if (deps.sleepMs) deps.sleepMs(2000);
  else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  const st = forwarderAgentState(deps, label);
  if (!st.running) {
    const logFile = path.join(deps.boardDir, 'webhook-forward.log');
    let tail = '';
    try {
      tail = readFileSync(logFile, 'utf-8').trimEnd().split('\n').slice(-10).join('\n');
    } catch {
      /* no log yet */
    }
    throw new ForwarderPersistError(
      `forwarder agent ${label} is loaded but not running (${describeNotRunning(st)}), the forwarder is NOT persisted.\n` +
        `tail of ${logFile}:\n${tail || '(empty)'}\nplist: ${plist}`,
    );
  }
  deps.log(`forwarder agent ${label} loaded for ${repo}`);
  return true;
}

/** The machine-wide launch agent label used before AISDLC-1256. */
export const LEGACY_FORWARDER_LABEL = 'io.ai-sdlc.webhook-forward';

/** Unload a legacy machine-wide agent and delete its plist, once. Best effort. */
export function removeLegacyForwarder(deps: HierarchyDeps): void {
  deps.run('launchctl', ['bootout', agentDomain(LEGACY_FORWARDER_LABEL)], { cwd: deps.cwd });
  rmSync(forwarderPlistPath(deps, LEGACY_FORWARDER_LABEL), { force: true });
}

/** Unload the agent, delete its plist and any leftover `cli` hook. Best effort. */
export function removeForwarder(deps: HierarchyDeps, label = forwarderLabel(deps)): void {
  deps.run('launchctl', ['bootout', agentDomain(label)], { cwd: deps.cwd });
  rmSync(forwarderPlistPath(deps, label), { force: true });
  try {
    const n = deleteStaleCliHooks(deps, resolveRepo(deps));
    if (n > 0) deps.log(`removed ${n} leftover cli hook(s)`);
  } catch {
    /* repository unresolved: nothing to clean */
  }
}
