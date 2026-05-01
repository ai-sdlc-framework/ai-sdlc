/**
 * Step 4 — Flip task status to In Progress + write the per-worktree
 * `.active-task` sentinel (AISDLC-81).
 *
 * The status flip side of this step requires the plugin's `task_edit`
 * MCP tool (which preserves unknown frontmatter keys); when invoked via
 * the CLI we don't have access to MCP tools, so we patch the frontmatter
 * directly with the same key-preserving semantics — matching what the
 * plugin's drop-in tool does in production.
 *
 * Sentinel: a plain text file at `<worktreePath>/.active-task` containing
 * the task ID. The PreToolUse hook walks up from the developer subagent's
 * cwd to find this sentinel and resolve `permittedExternalPaths`.
 *
 * @module steps/04-flip-status
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTaskFile } from './01-validate.js';
import type { BeginTaskResult } from '../types.js';

export interface BeginTaskOptions {
  taskId: string;
  worktreePath: string;
  workDir: string;
  /** Set the status to a value other than 'In Progress' (test override). */
  status?: string;
}

/**
 * Patch the YAML frontmatter `status:` line in-place. Preserves all other
 * lines verbatim — matches the plugin's `task_edit` key-preservation contract.
 *
 * Exported for unit testing.
 */
export function patchFrontmatterStatus(raw: string, newStatus: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) {
    throw new Error('task file missing YAML frontmatter');
  }
  const fmRaw = fm[1];
  const body = fm[2];
  let foundStatus = false;
  const patched = fmRaw
    .split('\n')
    .map((line) => {
      const m = line.match(/^(status:\s*)(.+)$/);
      if (m) {
        foundStatus = true;
        return `${m[1]}${newStatus}`;
      }
      return line;
    })
    .join('\n');
  const finalFm = foundStatus ? patched : `${patched}\nstatus: ${newStatus}`;
  return `---\n${finalFm}\n---\n${body}`;
}

export async function beginTask(opts: BeginTaskOptions): Promise<BeginTaskResult> {
  const status = opts.status ?? 'In Progress';
  const taskFile = findTaskFile(opts.taskId, opts.workDir);
  if (!taskFile) {
    throw new Error(`Step 4 begin-task: no task file found for ${opts.taskId}`);
  }
  const raw = readFileSync(taskFile, 'utf8');
  const patched = patchFrontmatterStatus(raw, status);
  writeFileSync(taskFile, patched, 'utf8');

  // Per-worktree sentinel (AISDLC-81). Lives INSIDE the worktree so the
  // PreToolUse hook can resolve it by walking up from the agent's cwd.
  const sentinelPath = join(opts.worktreePath, '.active-task');
  writeFileSync(sentinelPath, `${opts.taskId}\n`, 'utf8');

  return { taskId: opts.taskId, worktreePath: opts.worktreePath, sentinelPath };
}
