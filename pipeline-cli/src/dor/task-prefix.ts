/**
 * The task-id prefix of the repository (AISDLC-1360): `task_prefix` in `backlog/config.yml`,
 * regex-escaped, upper-cased; AISDLC when unset. Per `workDir`, so an adopter prefix works.
 *
 * @module dor/task-prefix
 */

import { readConfiguredTaskPrefix } from '../steps/00-5-sync-parent.js';

export const DEFAULT_TASK_PREFIX = 'AISDLC';

/** Escape regex metacharacters. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source of the prefix (escaped). */
export function taskPrefixSource(workDir?: string): string {
  const configured = workDir ? readConfiguredTaskPrefix(workDir) : null;
  return escapeRegex((configured ?? DEFAULT_TASK_PREFIX).toUpperCase());
}

/** Source of a task id: `<PREFIX>-N` or `<PREFIX>-N.M`. */
export function taskIdSource(workDir?: string): string {
  return String.raw`${taskPrefixSource(workDir)}-\d+(?:\.\d+)?`;
}
