/**
 * Reversal of a false `mark-landed` (AISDLC-1235): remove the `done/` completion marker,
 * verdict and manifest of a task that never had a merged code PR, and log why.
 */
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { now as clockNow } from '../clock.js';
import { detectKind, taskIdFrom } from '../hierarchy/reconcile.js';
import type { CommandRunner } from '../hierarchy/types.js';

const TASK_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*$/;
export const UNLAND_LOG = 'board-events.jsonl';

/** Merged PR numbers that are the task's own code PR (docs-lane filing PRs do not count). */
export function mergedCodePrs(taskId: string, run: CommandRunner, cwd: string): number[] {
  const r = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      `${taskId} in:title`,
      '--limit',
      '100',
      '--json',
      'number,title,headRefName',
    ],
    { cwd },
  );
  if (r.status !== 0) throw new Error(`gh pr list failed: ${(r.stderr ?? '').trim()}`);
  const prs = JSON.parse(r.stdout || '[]') as {
    number: number;
    title?: string;
    headRefName?: string;
  }[];
  return prs
    .filter((p) => {
      const id = taskIdFrom(p.headRefName, p.title);
      if (id.toLowerCase() !== taskId.toLowerCase()) return false;
      return detectKind({ title: p.title, headBranch: p.headRefName, taskId: id }) === 'task';
    })
    .map((p) => p.number);
}

/** Remove the landing artifacts; throws when a merged code PR exists. Returns removed files. */
export function unlandTask(
  boardDir: string,
  taskId: string,
  reason: string,
  opts: { run: CommandRunner; cwd: string; withManifest?: boolean },
): string[] {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`malformed task id ${taskId}`);
  const merged = mergedCodePrs(taskId, opts.run, opts.cwd);
  if (merged.length > 0) {
    throw new Error(
      `${taskId} has a merged code PR (#${merged.join(', #')}); it did land, nothing to unland`,
    );
  }
  const names = [`${taskId}.completed.json`, `${taskId}.verdict.json`, `${taskId}.diagnostic.json`];
  if (opts.withManifest) names.push(`${taskId}.manifest.json`);
  const removed: string[] = [];
  for (const n of names) {
    const f = path.join(boardDir, 'done', n);
    if (existsSync(f)) {
      rmSync(f);
      removed.push(f);
    }
  }
  appendFileSync(
    path.join(boardDir, UNLAND_LOG),
    JSON.stringify({
      event: 'unland',
      taskId,
      reason,
      removed: removed.map((f) => path.basename(f)),
      at: clockNow().toISOString(),
    }) + '\n',
    'utf-8',
  );
  return removed;
}
