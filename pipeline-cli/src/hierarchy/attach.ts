/**
 * `cli-hierarchy attach <name>`: show one agent in the current terminal.
 *
 * Inside tmux (`TMUX` set) the client is switched with `switch-client`, because
 * `attach-session` would nest a client in a client. Outside tmux it attaches.
 * The target always comes from the checked roster, never from raw input.
 */

import { isLegacyLayoutEntry, readRosterChecked, unsafeEntryReason } from './roster.js';
import { hasSession } from './tmux.js';
import type { HierarchyDeps, RosterEntry } from './types.js';
import { assertSessionName } from './validate.js';

/** True when the current process runs inside a tmux client. */
export function insideTmux(env: NodeJS.ProcessEnv): boolean {
  return typeof env.TMUX === 'string' && env.TMUX.length > 0;
}

/**
 * Show a roster entry in this terminal; returns the exit code of the
 * interactive tmux command.
 * @throws when the entry is not safe to target or its tmux session is not running.
 */
export function attachEntry(entry: RosterEntry, deps: HierarchyDeps): number {
  const reason = unsafeEntryReason(entry);
  if (reason) throw new Error(`refusing to attach to '${entry.name}': it ${reason}`);
  assertSessionName(entry.tmuxSession);
  assertSessionName(entry.tmuxWindow);
  if (!hasSession(deps.run, entry.tmuxSession)) {
    throw new Error(
      `the tmux session for '${entry.name}' is not running; start it with cli-hierarchy up`,
    );
  }
  // Old layout: the agent is a window of the shared session; bring it to the front first.
  if (isLegacyLayoutEntry(entry)) {
    deps.run('tmux', ['select-window', '-t', `=${entry.tmuxSession}:${entry.tmuxWindow}`]);
  }
  const mode = insideTmux(deps.env) ? 'switch-client' : 'attach-session';
  return deps.attach([mode, '-t', `=${entry.tmuxSession}`]);
}

/**
 * Resolve `name` against the checked roster and show that agent.
 * @throws with the valid names when `name` is not in the roster.
 */
export function hierarchyAttach(name: string, deps: HierarchyDeps): number {
  // Lookup is by string equality only; the name is validated before it reaches any argv
  // (attachEntry), and an invalid or unknown name just lists the valid ones.
  const { roster, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) deps.log(`warning: ${r}; not touched`);
  const entry =
    roster.sessions.find((e) => e.tmuxWindow === name) ??
    roster.sessions.find((e) => e.name === name);
  if (!entry) {
    const names = roster.sessions.map((e) => e.tmuxWindow);
    throw new Error(
      `no agent named '${name}' in the roster; valid names: ${names.length > 0 ? names.join(', ') : '(none, run cli-hierarchy up)'}`,
    );
  }
  return attachEntry(entry, deps);
}
