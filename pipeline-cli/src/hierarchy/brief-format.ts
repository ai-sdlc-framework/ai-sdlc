/**
 * Dispatch brief wire format: the YAML block that the board ingests.
 *
 * The block is a fenced `yaml` code block holding a mapping with one key,
 * `dispatchBrief`, whose value is a list of entries:
 *
 *     ```yaml
 *     dispatchBrief:
 *       - task: PROJ-12
 *         after: [PROJ-10]
 *         sequenceGroup: schema-regen
 *         wave: 2
 *         priority: 1
 *     ```
 *
 * `renderBriefBlock` and `parseBrief` are the only places that know this
 * shape. Anything that ingests a brief imports `parseBrief` instead of
 * re-implementing the format.
 */

import { dump, load } from 'js-yaml';

import { isValidTaskId } from './validate.js';

/** Key of the YAML list inside the brief's fenced block. */
export const BRIEF_BLOCK_KEY = 'dispatchBrief';

/** Pattern every sequence group name must satisfy (generated and parsed alike). */
export const GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Largest brief `parseBrief` accepts, in bytes. */
export const MAX_BRIEF_BYTES = 256 * 1024;
/** Most dispatch entries `parseBrief` accepts. */
export const MAX_BRIEF_ENTRIES = 500;

/** One dispatchable task in a brief. */
export interface BriefEntry {
  /** Backlog task id. */
  task: string;
  /** Task ids that must be done before this one is claimable. */
  after: string[];
  /** At most one task of a group runs at a time. Absent when the task has none. */
  sequenceGroup?: string;
  /** 1-based wave number derived from dependencies. */
  wave: number;
  /**
   * Optional integer ordering hint, matching the dispatch manifest `priority`:
   * claim order is wave, then priority (lower first), then enqueue time.
   * Backlog priorities map high=1, medium=2, low=3; absent when the task has none.
   */
  priority?: number;
}

/** A parsed brief. */
export interface ParsedBrief {
  entries: BriefEntry[];
}

/** Render the fenced YAML block (including fences) for the given entries. */
export function renderBriefBlock(entries: readonly BriefEntry[]): string {
  const list = entries.map((e) => {
    const out: Record<string, unknown> = { task: e.task, after: [...e.after] };
    if (e.sequenceGroup !== undefined) out.sequenceGroup = e.sequenceGroup;
    out.wave = e.wave;
    if (e.priority !== undefined) out.priority = e.priority;
    return out;
  });
  const body = dump({ [BRIEF_BLOCK_KEY]: list }, { flowLevel: 3, lineWidth: 120 }).trimEnd();
  return '```yaml\n' + body + '\n```';
}

function validateEntry(raw: unknown, index: number): BriefEntry {
  const label = `${BRIEF_BLOCK_KEY}[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.task !== 'string' || !isValidTaskId(r.task)) {
    throw new Error(`${label}.task is not a valid task id`);
  }
  const afterRaw = r.after ?? [];
  if (!Array.isArray(afterRaw)) throw new Error(`${label}.after must be a list`);
  const after = afterRaw.map((a) => {
    if (typeof a !== 'string' || !isValidTaskId(a)) {
      throw new Error(`${label}.after has an invalid task id`);
    }
    return a;
  });
  if (typeof r.wave !== 'number' || !Number.isInteger(r.wave) || r.wave < 1) {
    throw new Error(`${label}.wave must be a whole number of at least 1`);
  }
  const entry: BriefEntry = { task: r.task, after, wave: r.wave };
  if (r.sequenceGroup !== undefined && r.sequenceGroup !== null) {
    if (typeof r.sequenceGroup !== 'string' || !GROUP_PATTERN.test(r.sequenceGroup)) {
      throw new Error(`${label}.sequenceGroup is not a valid group name`);
    }
    entry.sequenceGroup = r.sequenceGroup;
  }
  if (r.priority !== undefined && r.priority !== null) {
    if (typeof r.priority !== 'number' || !Number.isInteger(r.priority)) {
      throw new Error(`${label}.priority must be a whole number`);
    }
    entry.priority = r.priority;
  }
  return entry;
}

/**
 * Parse the dispatch block out of a brief's Markdown.
 * @throws when there is no block, more than one, or an entry is malformed.
 */
export function parseBrief(markdown: string): ParsedBrief {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_BRIEF_BYTES) {
    throw new Error(`brief is larger than ${MAX_BRIEF_BYTES / 1024} KB`);
  }
  const fence = /^```yaml[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  const blocks: unknown[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) {
    let doc: unknown;
    try {
      doc = load(m[1]);
    } catch (err) {
      throw new Error(`brief YAML block is not valid YAML: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (typeof doc === 'object' && doc !== null && BRIEF_BLOCK_KEY in doc) {
      blocks.push((doc as Record<string, unknown>)[BRIEF_BLOCK_KEY]);
    }
  }
  if (blocks.length === 0) throw new Error(`brief has no '${BRIEF_BLOCK_KEY}' YAML block`);
  if (blocks.length > 1) throw new Error(`brief has more than one '${BRIEF_BLOCK_KEY}' YAML block`);
  const list = blocks[0];
  if (list === null || list === undefined) return { entries: [] };
  if (!Array.isArray(list)) throw new Error(`'${BRIEF_BLOCK_KEY}' must be a list`);
  if (list.length > MAX_BRIEF_ENTRIES) {
    throw new Error(`brief has more than ${MAX_BRIEF_ENTRIES} entries`);
  }
  const entries = list.map((raw, i) => validateEntry(raw, i));
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.task)) throw new Error(`brief lists ${e.task} more than once`);
    seen.add(e.task);
  }
  return { entries };
}
