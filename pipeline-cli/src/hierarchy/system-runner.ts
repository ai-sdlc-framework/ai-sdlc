/**
 * The real command runner: spawns the program directly (no shell) and
 * captures its output. The bootstrap uses this in production; tests inject a
 * recording runner instead.
 */

import { spawnSync } from 'node:child_process';

import type { CommandResult, CommandRunner } from './types.js';

/** Maximum bytes of output captured from one command. */
const MAX_BUFFER = 4 * 1024 * 1024;

/** Create a runner backed by `child_process.spawnSync`. */
export function createSystemRunner(): CommandRunner {
  return (file, args, options): CommandResult => {
    const result = spawnSync(file, [...args], {
      cwd: options?.cwd,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (result.error ? result.error.message : ''),
    };
  };
}

/**
 * Run an interactive tmux command (`attach-session` or `switch-client`) with the
 * terminal's stdio inherited; returns the exit code.
 */
export function attachTmuxSession(args: readonly string[]): number {
  const result = spawnSync('tmux', [...args], { stdio: 'inherit' });
  return result.status ?? 1;
}
