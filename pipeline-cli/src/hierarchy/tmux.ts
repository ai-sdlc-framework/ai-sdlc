/**
 * Thin tmux wrappers. Every call goes through the injected command runner;
 * arguments are argv entries, never shell-interpolated.
 */

import type { CommandResult, CommandRunner } from './types.js';

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

/**
 * Start `command` in a new window. The first window creates the session
 * detached; later windows are added to it.
 */
export function startWindow(
  run: CommandRunner,
  session: string,
  window: string,
  command: string,
  cwd: string,
  sessionExists: boolean,
): CommandResult {
  const args = sessionExists
    ? ['new-window', '-t', `=${session}:`, '-n', window, '-c', cwd, command]
    : ['new-session', '-d', '-s', session, '-n', window, '-c', cwd, command];
  return run('tmux', args, { cwd });
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
