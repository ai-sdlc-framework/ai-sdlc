/**
 * Auto-brief (AISDLC-930): a task filed with `cli-file task --pr` gets a one-entry
 * dispatch brief, so the board sees it without the planner remembering to write one.
 * A hand-written brief is still needed for dependencies, sequence groups and holds.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { boardStateOf, DEFAULT_BOARD_DIR } from '../dispatch/board.js';
import { parseSimpleYaml } from '../steps/01-validate.js';
import { parseBrief, renderBriefBlock } from './brief-format.js';
import { PRIORITY_RANK } from './brief.js';
import { isValidTaskId } from './validate.js';

/** What a task file says about dispatching it. */
export interface TaskDispatchFacts {
  id: string;
  /** False for `dispatchable: false`, a `blocked.reason`, or a finished status. */
  eligible: boolean;
  priority?: number;
}

/** Read the dispatch facts out of a task file's frontmatter; undefined when it has none. */
export function readDispatchFacts(raw: string): TaskDispatchFacts | undefined {
  const text = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (text === undefined) return undefined;
  let fm: Record<string, unknown>;
  try {
    fm = parseSimpleYaml(text);
  } catch {
    return undefined;
  }
  const id = typeof fm.id === 'string' ? fm.id.toUpperCase() : '';
  if (!isValidTaskId(id)) return undefined;
  const blocked = fm.blocked as { reason?: unknown } | undefined;
  const hasBlock = typeof blocked === 'object' && blocked !== null && Boolean(blocked.reason);
  const flag = fm.dispatchable;
  const dispatchable = !(flag === false || String(flag).toLowerCase() === 'false');
  const status = String(fm.status ?? '').toLowerCase();
  const finished = status === 'done' || status === 'superseded';
  const rank = PRIORITY_RANK[String(fm.priority ?? '').toLowerCase()];
  return {
    id,
    eligible: dispatchable && !hasBlock && !finished,
    ...(rank !== undefined ? { priority: rank } : {}),
  };
}

/** Briefs directory of a board. */
function briefsDir(boardDir: string): string {
  return path.join(boardDir, 'briefs');
}

/**
 * Write `briefs/tasks-<id>.md` for a task file. Returns the path written, or undefined
 * when the task is not dispatchable or a brief of that name already exists.
 */
export function writeAutoBrief(
  repo: string,
  taskFile: string,
  boardDir: string = path.join(repo, DEFAULT_BOARD_DIR),
): string | undefined {
  const facts = readDispatchFacts(readFileSync(taskFile, 'utf8'));
  if (!facts?.eligible) return undefined;
  const dest = path.join(briefsDir(boardDir), `tasks-${facts.id.toLowerCase()}.md`);
  if (existsSync(dest)) return undefined;
  mkdirSync(path.dirname(dest), { recursive: true });
  const block = renderBriefBlock([
    {
      task: facts.id,
      after: [],
      wave: 1,
      ...(facts.priority !== undefined ? { priority: facts.priority } : {}),
    },
  ]);
  writeFileSync(
    dest,
    `# Dispatch brief: ${facts.id}\n\nWritten by \`cli-file task --pr\` (AISDLC-930). One independent task; no dependencies, sequence group or hold.\n\n${block}\n`,
  );
  return dest;
}

/**
 * Dispatchable open tasks under `<workDir>/backlog/tasks` that are on no brief and not on
 * the board: nothing would ever queue them.
 */
export function listUnbriefed(workDir: string, boardDir: string): string[] {
  const tasksDir = path.join(workDir, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) return [];
  const briefed = new Set<string>();
  const bdir = briefsDir(boardDir);
  if (existsSync(bdir)) {
    for (const f of readdirSync(bdir)) {
      if (!f.endsWith('.md')) continue;
      try {
        for (const e of parseBrief(readFileSync(path.join(bdir, f), 'utf8')).entries) {
          briefed.add(e.task);
        }
      } catch {
        /* an unparsable brief names no task */
      }
    }
  }
  const out: string[] = [];
  for (const f of readdirSync(tasksDir).sort()) {
    if (!f.endsWith('.md')) continue;
    const facts = readDispatchFacts(readFileSync(path.join(tasksDir, f), 'utf8'));
    if (!facts?.eligible || briefed.has(facts.id) || boardStateOf(boardDir, facts.id)) continue;
    out.push(facts.id);
  }
  return out;
}
