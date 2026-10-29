/**
 * `cli-hierarchy brief-status`: progress of each brief on the board.
 *
 * A brief's task is done when the board holds `done/<id>.verdict.json` for it.
 * The planner command prints this instead of looping over verdict files in shell.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseBrief } from './brief-format.js';
import { isValidTaskId } from './validate.js';

/** Progress of one brief. */
export interface BriefProgress {
  /** Brief file name. */
  file: string;
  done: number;
  total: number;
  /** Set when the brief could not be parsed. */
  error?: string;
}

/** Progress of every `*.md` brief under `<boardDir>/briefs`, sorted by file name. */
export function briefStatus(boardDir: string): BriefProgress[] {
  const dir = path.join(boardDir, 'briefs');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((file) => {
    try {
      const { entries } = parseBrief(readFileSync(path.join(dir, file), 'utf8'));
      const ids = entries.map((e) => e.task).filter(isValidTaskId);
      const done = ids.filter((id) =>
        existsSync(path.join(boardDir, 'done', `${id}.verdict.json`)),
      ).length;
      return { file, done, total: ids.length };
    } catch (err) {
      return { file, done: 0, total: 0, error: (err as Error).message };
    }
  });
}

/** One output line per brief, or a single line when there are none. */
export function formatBriefStatus(rows: readonly BriefProgress[]): string[] {
  if (rows.length === 0) return ['No briefs yet.'];
  return rows.map((r) =>
    r.error
      ? `${r.file}: unreadable (${r.error.replace(/\s+/g, ' ')})`
      : `${r.file}: ${r.done} of ${r.total} task(s) done`,
  );
}
