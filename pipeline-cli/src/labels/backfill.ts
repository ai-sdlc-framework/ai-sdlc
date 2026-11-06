/**
 * Backfill `taskClass` on existing assignment-log rows from the task file
 * (RFC-0062 OQ-3). Rewrites only rows whose class is `uncategorized`.
 *
 * @module labels/backfill
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { deriveTaskClass, readTaskFrontmatter } from './task-file.js';

export interface BackfillReport {
  rows: number;
  rewritten: number;
  stillUncategorized: number;
  /** Count of still-uncategorized rows by reason. */
  reasons: Record<string, number>;
}

export function backfillTaskClass(
  logPath: string,
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): BackfillReport {
  const report: BackfillReport = { rows: 0, rewritten: 0, stillUncategorized: 0, reasons: {} };
  if (!existsSync(logPath)) return report;
  const cache = new Map<string, { taskClass: string; reason?: string }>();
  const out: string[] = [];
  const bump = (why: string): void => {
    report.stillUncategorized++;
    report.reasons[why] = (report.reasons[why] ?? 0) + 1;
  };
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(line);
      continue;
    }
    report.rows++;
    if (rec.taskClass && rec.taskClass !== 'uncategorized') {
      out.push(line);
      continue;
    }
    const id = typeof rec.taskId === 'string' ? rec.taskId : '';
    let d = cache.get(id);
    if (!d) {
      if (!id) d = { taskClass: 'uncategorized', reason: 'row has no task id' };
      else {
        const { file, fm } = readTaskFrontmatter(repoRoot, id);
        d = file
          ? deriveTaskClass(fm)
          : { taskClass: 'uncategorized', reason: 'task file not found' };
      }
      cache.set(id, d);
    }
    if (d.taskClass === 'uncategorized') {
      bump(d.reason ?? 'unknown');
      out.push(line);
    } else {
      report.rewritten++;
      out.push(JSON.stringify({ ...rec, taskClass: d.taskClass }));
    }
  }
  if (!opts.dryRun && report.rewritten > 0) {
    const tmp = `${logPath}.tmp`;
    writeFileSync(tmp, out.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, logPath);
  }
  return report;
}
