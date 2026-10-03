/**
 * Thin tmux wrappers. Every call goes through the injected command runner;
 * arguments are argv entries, never shell-interpolated.
 */

import { isLegacyLayoutEntry } from './roster.js';
import type { CommandResult, CommandRunner, RosterEntry } from './types.js';

/** True when the tmux session exists. */
export function hasSession(run: CommandRunner, session: string): boolean {
  return run('tmux', ['has-session', '-t', `=${session}`]).status === 0;
}

/** Window names in the session; empty when the session does not exist. */
export function listWindows(run: CommandRunner, session: string): string[] {
  const r = run('tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_name}']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** True when the session exists and has a window of that name. */
export function windowLive(run: CommandRunner, session: string, window: string): boolean {
  return hasSession(run, session) && listWindows(run, session).includes(window);
}

/**
 * Start `command` in its own detached session. Session name and window name are
 * both `name`: every agent gets a session of its own so two terminals can show
 * two agents (clients attached to one shared session follow the same window).
 */
export function startSession(
  run: CommandRunner,
  name: string,
  command: string,
  cwd: string,
): CommandResult {
  return run('tmux', ['new-session', '-d', '-s', name, '-n', name, '-c', cwd, command], { cwd });
}

/**
 * Label one session so a terminal attached to it is recognisable: the terminal
 * title and the status line carry the agent name. Every option is scoped to the
 * session with `-t`; no global or server option is ever set.
 * @returns the first failing result, or the last successful one.
 */
export function setSessionTitles(run: CommandRunner, name: string): CommandResult {
  const target = `=${name}`;
  const options: string[][] = [
    ['set-titles', 'on'],
    ['set-titles-string', name],
    ['status-left', `[${name}] `],
  ];
  let last: CommandResult = { status: 0, stdout: '', stderr: '' };
  for (const [key, value] of options) {
    last = run('tmux', ['set-option', '-t', target, key as string, value as string]);
    if (last.status !== 0) return last;
  }
  return last;
}

/** True when at least one tmux client is attached to the session; false on any failure. */
export function sessionAttached(run: CommandRunner, session: string): boolean {
  const r = run('tmux', ['display-message', '-p', '-t', `=${session}`, '#{session_attached}']);
  if (r.status !== 0) return false;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0;
}

/** Pane id and pane pid of a window; empty values when they cannot be read. */
export function paneInfo(
  run: CommandRunner,
  session: string,
  window: string,
): { paneId: string; panePid: number } {
  const r = run('tmux', [
    'display-message',
    '-p',
    '-t',
    `=${session}:${window}`,
    '#{pane_id} #{pane_pid}',
  ]);
  if (r.status !== 0) return { paneId: '', panePid: 0 };
  const [paneId = '', pid = ''] = r.stdout.trim().split(/\s+/);
  const panePid = Number.parseInt(pid, 10);
  return { paneId, panePid: Number.isFinite(panePid) ? panePid : 0 };
}

/** Ask the session in a pane to exit gracefully. */
export function sendExit(run: CommandRunner, target: string): CommandResult {
  return run('tmux', ['send-keys', '-t', target, '/exit', 'Enter']);
}

/** Close a window. */
export function killWindow(run: CommandRunner, session: string, window: string): CommandResult {
  return run('tmux', ['kill-window', '-t', `=${session}:${window}`]);
}

/**
 * Target for keys sent to a roster entry. The recorded pane id is used only when
 * tmux confirms it still belongs to the roster window. When it does not (or tmux
 * cannot confirm it) nothing is sent: a stale or recycled pane id never falls back
 * to targeting the window by name.
 * @throws when a recorded pane id cannot be confirmed.
 */
export function resolveSendTarget(
  run: CommandRunner,
  session: string,
  window: string,
  paneId: string,
): string {
  const windowTarget = `=${session}:${window}`;
  if (!paneId) return windowTarget;
  const r = run('tmux', ['display-message', '-p', '-t', windowTarget, '#{pane_id}']);
  if (r.status === 0 && r.stdout.trim() === paneId) return paneId;
  throw new Error(
    `the recorded pane ${paneId} does not belong to window '${window}' of tmux session '${session}' any more (the roster entry is stale); refusing to send keys to it or close it`,
  );
}

/**
 * Session-scoped tmux user option that `up` sets on every session it creates. `down` and
 * `brief --notify` act on a session only when it carries it, so a personal session that
 * happens to share an agent's name is never typed into or closed.
 */
export const OWNER_OPTION = '@ai-sdlc-hierarchy';

/** Mark a session as started by `cli-hierarchy up` (session-scoped, never `-g`). */
export function markSessionOwned(run: CommandRunner, name: string): CommandResult {
  return run('tmux', ['set-option', '-t', `=${name}`, OWNER_OPTION, '1']);
}

/** True when the session carries the ownership marker. */
export function sessionOwned(run: CommandRunner, session: string): boolean {
  const r = run('tmux', ['show-options', '-v', '-t', `=${session}`, OWNER_OPTION]);
  return r.status === 0 && r.stdout.trim() === '1';
}

/**
 * Why the tool must not send keys to or close this entry's tmux session, or undefined
 * when it may. Entries of the old layout (windows of the shared `ai-sdlc-hierarchy`
 * session) predate the marker and carry no ownership check.
 */
export function ownershipRefusal(run: CommandRunner, entry: RosterEntry): string | undefined {
  if (isLegacyLayoutEntry(entry)) return undefined;
  if (sessionOwned(run, entry.tmuxSession)) return undefined;
  return `tmux session '${entry.tmuxSession}' (roster entry '${entry.name}') does not carry the ${OWNER_OPTION} marker, so cli-hierarchy did not start it; refusing to send keys to it or close it. If it really is a hierarchy agent, mark it with: tmux set-option -t =${entry.tmuxSession} ${OWNER_OPTION} 1`;
}
