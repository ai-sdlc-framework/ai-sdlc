/**
 * Input validation for the session-hierarchy bootstrap.
 *
 * Every value that ends up in a tmux target, a window name, a file path or a
 * shell command line passes through here first. The task-id pattern mirrors the
 * one the parallel-execute command applies, so the two cannot drift.
 */

import type { HierarchyRole } from './types.js';

/** Hard cap on concurrent executors. */
export const MAX_EXECUTORS = 5;

/** Greek letters used to name executors, in order. */
export const GREEK_LETTERS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const;

const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]+-[0-9]+(\.[0-9]+)*$/;
const SESSION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,63}$/;
const PERMISSION_MODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** True when `id` is a well-formed backlog task id (for example `AISDLC-1.2`). */
export function isValidTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id);
}

/** True when `name` is safe to use as a session name and tmux window name. */
export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name);
}

/** Throw unless `name` is a safe session name. */
export function assertSessionName(name: string): void {
  if (!isValidSessionName(name)) {
    throw new Error(
      `invalid session name '${name}': use lowercase letters, digits and hyphens, starting with a letter`,
    );
  }
}

/** Throw unless `model` looks like a model alias or id. */
export function assertModel(model: string, flag: string): void {
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(`invalid ${flag} '${model}'`);
  }
}

/** Throw unless `mode` looks like a permission mode name. */
export function assertPermissionMode(mode: string): void {
  if (!PERMISSION_MODE_PATTERN.test(mode)) {
    throw new Error(`invalid permission mode '${mode}'`);
  }
}

/**
 * Validate the requested executor count. Returns the count.
 * @throws when it is not an integer in 0..MAX_EXECUTORS.
 */
export function parseExecutorCount(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--executors must be a whole number between 0 and ${MAX_EXECUTORS}`);
  }
  if (n > MAX_EXECUTORS) {
    throw new Error(
      `--executors ${n} exceeds the limit of ${MAX_EXECUTORS} concurrent executors; refusing to start a sixth`,
    );
  }
  return n;
}

/** Executor session names for the first `count` Greek letters. */
export function executorNames(count: number): string[] {
  return GREEK_LETTERS.slice(0, count).map((letter) => `executor-${letter}`);
}

/** Role a roster-style name belongs to, or undefined when it is not a default name. */
export function roleOfDefaultName(name: string): HierarchyRole | undefined {
  if (name === 'planner') return 'planner';
  if (name === 'operator-dispatch') return 'operator-dispatch';
  if ((executorNames(MAX_EXECUTORS) as string[]).includes(name)) return 'executor';
  return undefined;
}

/** Quote one argument for a POSIX shell using single quotes. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
