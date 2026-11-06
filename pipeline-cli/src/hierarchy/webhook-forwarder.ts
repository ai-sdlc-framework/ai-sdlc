/**
 * The `gh webhook forward` feed as a supervised launchd agent (AISDLC-1207). `webhook up
 * --feed gh-forward` installs the agent (KeepAlive), after deleting stale `cli` hooks that a
 * forwarder dying uncleanly leaves behind (`HTTP 422 Hook already exists`). Liveness is read
 * from the agent label, never from a recorded pid. Non-macOS: the command is printed.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HierarchyDeps } from './types.js';

export const FORWARDER_LABEL = 'io.ai-sdlc.webhook-forward';
export const FORWARD_EVENTS =
  'pull_request,check_suite,check_run,workflow_run,status,pull_request_review';

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0);
const domain = (): string => `gui/${uid()}/${FORWARDER_LABEL}`;

export function forwarderPlistPath(deps: HierarchyDeps): string {
  const home = deps.env.HOME || os.homedir();
  return path.join(home, 'Library', 'LaunchAgents', `${FORWARDER_LABEL}.plist`);
}

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

export function renderPlist(args: string[], logPath: string, envPath: string): string {
  const argv = ['/usr/bin/env', ...args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${FORWARDER_LABEL}</string>
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

/** Whether launchd has the agent loaded. */
export function forwarderAgentAlive(deps: HierarchyDeps): boolean {
  try {
    return deps.run('launchctl', ['print', domain()], { cwd: deps.cwd })?.status === 0;
  } catch {
    return false;
  }
}

/**
 * Install and load the agent. Returns true when launchd manages it; false (command printed)
 * on a platform without launchd. Throws when the secret is missing.
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
  const removed = deleteStaleCliHooks(deps, repo);
  if (removed > 0) deps.log(`removed ${removed} stale cli hook(s) on ${repo}`);
  const plist = forwarderPlistPath(deps);
  mkdirSync(path.dirname(plist), { recursive: true });
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(
    plist,
    renderPlist(
      args,
      path.join(deps.boardDir, 'webhook-forward.log'),
      deps.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    ),
    { mode: 0o600 },
  );
  deps.run('launchctl', ['bootout', domain()], { cwd: deps.cwd });
  const r = deps.run('launchctl', ['bootstrap', `gui/${uid()}`, plist], { cwd: deps.cwd });
  if (r?.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r?.stderr ?? '').trim()}`);
  deps.log(`forwarder agent ${FORWARDER_LABEL} loaded for ${repo}`);
  return true;
}

/** Unload the agent, delete its plist and any leftover `cli` hook. Best effort. */
export function removeForwarder(deps: HierarchyDeps): void {
  deps.run('launchctl', ['bootout', domain()], { cwd: deps.cwd });
  rmSync(forwarderPlistPath(deps), { force: true });
  try {
    const n = deleteStaleCliHooks(deps, resolveRepo(deps));
    if (n > 0) deps.log(`removed ${n} leftover cli hook(s)`);
  } catch {
    /* repository unresolved: nothing to clean */
  }
}
