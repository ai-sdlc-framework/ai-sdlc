/**
 * `cli-hierarchy handoff write|read` (AISDLC-766): a handoff file for every
 * hierarchy session that is generated from board and catalog state, never from
 * prose, so a session can be cleared at any instant and resume from the file.
 *
 * Files:
 *  - dispatch and executors: `<board-dir>/handoff/<session-name>.md`
 *  - planner: the dated memory file `<repo>/.claude/memory/project_planner_handoff_YYYY_MM_DD.md`
 *
 * The generated block sits between two marker comments and carries a hash of the
 * state it was generated from. Text outside the markers (the planner's own notes)
 * is kept on every rewrite. `read` recomputes the hash first: a file whose hash
 * no longer matches the live state is regenerated before it is returned, so a stale
 * file is never read as current.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { now as clock } from '../clock.js';
import { listBoard, readInflightManifest, type BoardEntry } from '../dispatch/board.js';
import { listRulings, type BoardRuling } from '../dispatch/ruling.js';
import { listDecisions } from '../decisions/projection.js';
import { listInflight } from './inflight.js';
import { readRoster } from './roster.js';
import type { HierarchyRole } from './types.js';

export const HANDOFF_BEGIN = '<!-- ai-sdlc-handoff:begin -->';
export const HANDOFF_END = '<!-- ai-sdlc-handoff:end -->';
const HASH_RE = /<!-- state-hash: ([0-9a-f]{64}) -->/;

/** The command each role runs to resume after a clear. */
export const RESUME_COMMANDS: Record<HierarchyRole, string> = {
  planner: '/ai-sdlc:planner',
  'operator-dispatch': '/ai-sdlc operator-dispatch',
  executor: '/ai-sdlc executor',
};

/** The live state a handoff is generated from. */
export interface HandoffState {
  roster: { name: string; role: string; status: string }[];
  board: BoardEntry[];
  inflight: { taskId: string; workerId?: string }[];
  openDecisions: { id: string; lifecycle: string; summary: string }[];
  /** Planner rulings in force on the board (AISDLC-903). */
  rulings: BoardRuling[];
}

/** Inputs of {@link writeHandoff} / {@link readHandoff}. */
export interface HandoffOptions {
  role: HierarchyRole;
  /** Roster name of the session; defaults to the role name. */
  name?: string;
  boardDir: string;
  now?: () => Date;
  /** Overrides the file location (tests). */
  file?: string;
  /** Planner only: roll older notes into `<basename>_archive.md` (default true; AISDLC-933). */
  archive?: boolean;
}

/** Result of a write or read. */
export interface HandoffResult {
  file: string;
  stateHash: string;
  /** read: the file was missing or stale and was regenerated first. */
  regenerated: boolean;
  content: string;
  /** write: older notes blocks and loose prose moved to the archive file. */
  archivedBlocks?: number;
  archiveFile?: string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function repoRootOf(boardDir: string): string {
  // <repo>/.ai-sdlc/dispatch -> <repo>
  return path.resolve(boardDir, '..', '..');
}

/** Collect the live state. Never throws on a missing catalog. */
export function collectHandoffState(boardDir: string, now: () => Date = clock): HandoffState {
  let roster: HandoffState['roster'];
  try {
    roster = readRoster(boardDir).sessions.map((s) => ({
      name: s.name,
      role: s.role,
      status: s.status,
    }));
  } catch {
    roster = [];
  }
  roster.sort((a, b) => a.name.localeCompare(b.name));
  const board = listBoard(boardDir, now)
    .map((e) => ({ ...e }))
    .sort(
      (a, b) =>
        a.state.localeCompare(b.state) || a.taskId.localeCompare(b.taskId, 'en', { numeric: true }),
    );
  let openDecisions: HandoffState['openDecisions'];
  try {
    openDecisions = listDecisions({ workDir: repoRootOf(boardDir) })
      .decisions.filter((d) => ['proposed', 'open', 'deferred'].includes(d.status.lifecycle))
      .map((d) => ({
        id: d.metadata.id,
        lifecycle: d.status.lifecycle,
        summary: String(d.spec.summary ?? '').slice(0, 160),
      }));
  } catch {
    openDecisions = [];
  }
  const inflight = listInflight(boardDir).map((i) => {
    const workerId = i.workerId ?? readInflightManifest(boardDir, i.taskId)?.workerId;
    return { taskId: i.taskId, ...(workerId ? { workerId } : {}) };
  });
  return { roster, board, inflight, openDecisions, rulings: listRulings(boardDir) };
}

/** Hash of the state; identical state always gives the identical hash. */
export function hashHandoffState(state: HandoffState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function nextAction(role: HierarchyRole, name: string, state: HandoffState): string {
  const held = state.inflight.find((i) => i.workerId === name);
  if (role === 'executor') {
    return held
      ? `You hold ${held.taskId}. Continue it with \`/ai-sdlc execute ${held.taskId}\`; do not claim another task.`
      : 'You hold no task. Run `cli-hierarchy executor-start` and take the task it returns.';
  }
  if (role === 'operator-dispatch') {
    return 'Run one `cli-hierarchy tick` and send the reports and escalations it prints.';
  }
  return 'Read the roster, briefs and open decisions below, then continue from the first open item.';
}

/** Render the generated block for a role from the live state. */
export function renderHandoff(
  role: HierarchyRole,
  name: string,
  state: HandoffState,
  generatedAt: string,
): string {
  const hash = hashHandoffState(state);
  const byState = (s: string): BoardEntry[] => state.board.filter((e) => e.state === s);
  const ids = (es: BoardEntry[]): string =>
    es.length ? es.map((e) => e.taskId).join(', ') : '(none)';
  const queue = byState('queue');
  const lines = [
    HANDOFF_BEGIN,
    `<!-- state-hash: ${hash} -->`,
    `# Handoff: ${name} (${role})`,
    '',
    `Generated ${generatedAt} by \`cli-hierarchy handoff write\` from board and catalog state.`,
    `Resume command: \`${RESUME_COMMANDS[role]}\``,
    '',
    '## Next action',
    nextAction(role, name, state),
    '',
    '## Roster',
    ...(state.roster.length
      ? state.roster.map((s) => `- ${s.name} (${s.role}, ${s.status})`)
      : ['- (empty)']),
    '',
    '## Board',
    `- Queue, eligible: ${ids(queue.filter((e) => e.eligible))}`,
    `- Queue, held: ${
      queue.filter((e) => !e.eligible).length
        ? queue
            .filter((e) => !e.eligible)
            .map((e) => `${e.taskId} (${e.reason ?? 'held'})`)
            .join(', ')
        : '(none)'
    }`,
    `- Inflight: ${
      state.inflight.length
        ? state.inflight.map((i) => `${i.taskId}${i.workerId ? ` (${i.workerId})` : ''}`).join(', ')
        : '(none)'
    }`,
    `- Blocked: ${ids(byState('blocked'))}`,
    `- Done: ${byState('done').length}; failed: ${ids(byState('failed'))}`,
    '',
    '## Open decisions',
    ...(state.openDecisions.length
      ? state.openDecisions.map((d) => `- ${d.id} [${d.lifecycle}] ${d.summary}`)
      : ['- (none)']),
    ...(role === 'operator-dispatch'
      ? [
          '',
          '## Rulings in force',
          ...(state.rulings.length
            ? state.rulings.map(
                (r) =>
                  `- ${r.taskId}: ${r.text} (until: ${r.until ?? '(none)'}; by: ${r.by ?? '(unknown)'}; at: ${r.at})`,
              )
            : ['- (none)']),
        ]
      : []),
    HANDOFF_END,
  ];
  return lines.join('\n') + '\n';
}

/** Path of the handoff file for a role and session. */
export function handoffPath(opts: HandoffOptions, now: Date): string {
  if (opts.file) return opts.file;
  const name = opts.name ?? opts.role;
  if (!SAFE_NAME.test(name)) throw new Error(`'${name}' is not a valid session name`);
  if (opts.role === 'planner') {
    const dir = path.join(repoRootOf(opts.boardDir), '.claude', 'memory');
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '_');
    return path.join(dir, `project_planner_handoff_${stamp}.md`);
  }
  return path.join(opts.boardDir, 'handoff', `${name}.md`);
}

const PLANNER_HANDOFF_RE = /^project_planner_handoff_[0-9_]+\.md$/;

/** The newest earlier dated planner handoff, whose text outside the markers a new day's file inherits. */
function newestPlannerHandoff(file: string, opts: HandoffOptions): string | undefined {
  if (opts.role !== 'planner' || opts.file) return undefined;
  const dir = path.dirname(file);
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir)
    .filter((f) => PLANNER_HANDOFF_RE.test(f))
    .sort()
    .pop();
  return newest ? path.join(dir, newest) : undefined;
}

/** Make `MEMORY.md` list the given handoff file, replacing any earlier dated handoff entry. */
function pointMemoryIndexAt(file: string): void {
  const index = path.join(path.dirname(file), 'MEMORY.md');
  const base = path.basename(file);
  const current = existsSync(index) ? readFileSync(index, 'utf-8') : '';
  const lines = current.split('\n');
  const at = lines.findIndex((l) => /\(project_planner_handoff_[0-9_]+\.md\)/.test(l));
  if (at !== -1) {
    lines[at] = lines[at]!.replace(/\(project_planner_handoff_[0-9_]+\.md\)/, `(${base})`);
  } else if (current.includes(base)) {
    return;
  } else {
    const head = current.replace(/\s*$/, '');
    lines.splice(
      0,
      lines.length,
      ...(head ? head.split('\n') : []),
      `- [Planner handoff](${base}) - generated by \`cli-hierarchy handoff write\`; READ FIRST`,
      '',
    );
  }
  const out = lines.join('\n');
  if (out !== current) writeFileSync(index, out, 'utf-8');
}

function splice(existing: string | undefined, block: string): string {
  if (!existing) return block;
  const start = existing.indexOf(HANDOFF_BEGIN);
  const end = existing.indexOf(HANDOFF_END);
  if (start === -1 || end === -1 || end < start) {
    const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(existing);
    const at = fm ? fm[0].length : 0;
    const rest = existing.slice(at).replace(/^\s+/, '');
    return (
      existing.slice(0, at) +
      (at && !existing.slice(0, at).endsWith('\n') ? '\n' : '') +
      block +
      (rest ? '\n' + rest : '')
    );
  }
  return existing.slice(0, start) + block.trimEnd() + existing.slice(end + HANDOFF_END.length);
}

const RESUME_HEADING_RE = /^## RESUME HERE\b/;

/**
 * Keep one current notes block (AISDLC-933). Splits `text` into frontmatter, loose prose
 * before the generated block (an optional leading `# ` title line stays as header), the
 * generated block, and the text after it. Prose before the block and every `## RESUME HERE`
 * section but the last one come back as `archived`; the rest stays in `kept`.
 */
export function rollArchive(text: string): { kept: string; archived: string[] } {
  const start = text.indexOf(HANDOFF_BEGIN);
  const end = text.indexOf(HANDOFF_END);
  if (start === -1 || end === -1 || end < start) return { kept: text, archived: [] };
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fmLen = fm && fm[0].length <= start ? fm[0].length : 0;
  const archived: string[] = [];
  let before = text.slice(fmLen, start);
  let header = '';
  const title = /^\s*# [^\n]*\n/.exec(before);
  if (title) {
    header = title[0].replace(/^\s+/, '');
    before = before.slice(title[0].length);
  }
  if (before.trim()) archived.push(before.trim());
  const blockEnd = end + HANDOFF_END.length;
  const after = text.slice(blockEnd);
  const lines = after.split('\n');
  const sections: { from: number; to: number }[] = [];
  let open = -1;
  lines.forEach((line, i) => {
    if (/^## /.test(line)) {
      if (open !== -1) sections.push({ from: open, to: i });
      open = RESUME_HEADING_RE.test(line) ? i : -1;
    }
  });
  if (open !== -1) sections.push({ from: open, to: lines.length });
  const drop = new Set<number>();
  for (const sec of sections.slice(0, -1)) {
    archived.push(lines.slice(sec.from, sec.to).join('\n').trim());
    for (let i = sec.from; i < sec.to; i++) drop.add(i);
  }
  const keptAfter = lines.filter((_, i) => !drop.has(i)).join('\n');
  if (!archived.length) return { kept: text, archived };
  const kept =
    text.slice(0, fmLen) +
    header +
    text.slice(start, blockEnd) +
    keptAfter.replace(/\n{3,}/g, '\n\n');
  return { kept, archived };
}

/** Generate the handoff from live state and write it. */
export function writeHandoff(opts: HandoffOptions): HandoffResult {
  const now = (opts.now ?? clock)();
  const name = opts.name ?? opts.role;
  const file = handoffPath(opts, now);
  const state = collectHandoffState(opts.boardDir, () => now);
  const block = renderHandoff(opts.role, name, state, now.toISOString());
  const carried = existsSync(file) ? file : newestPlannerHandoff(file, opts);
  const existing = carried ? readFileSync(carried, 'utf-8') : undefined;
  let content = splice(existing, block);
  mkdirSync(path.dirname(file), { recursive: true });
  let archivedBlocks: number | undefined;
  let archiveFile: string | undefined;
  if (opts.role === 'planner' && opts.archive !== false) {
    const rolled = rollArchive(content);
    archivedBlocks = rolled.archived.length;
    archiveFile = path.join(
      path.dirname(file),
      `${path.basename(file).replace(/\.md$/, '')}_archive.md`,
    );
    if (rolled.archived.length) {
      content = rolled.kept;
      const prior = existsSync(archiveFile) ? readFileSync(archiveFile, 'utf-8').trimEnd() : '';
      const add = rolled.archived.join('\n\n');
      writeFileSync(archiveFile, (prior ? prior + '\n\n' : '') + add + '\n', 'utf-8');
    }
  }
  writeFileSync(file, content, 'utf-8');
  if (opts.role === 'planner' && !opts.file) pointMemoryIndexAt(file);
  return {
    file,
    stateHash: hashHandoffState(state),
    regenerated: false,
    content,
    ...(archivedBlocks === undefined ? {} : { archivedBlocks, archiveFile }),
  };
}

/**
 * Return the handoff content. A missing file, or one whose recorded state hash
 * differs from the live state, is regenerated first.
 */
export function readHandoff(opts: HandoffOptions): HandoffResult {
  const now = (opts.now ?? clock)();
  const file = handoffPath(opts, now);
  const live = hashHandoffState(collectHandoffState(opts.boardDir, () => now));
  if (existsSync(file)) {
    const content = readFileSync(file, 'utf-8');
    const recorded = HASH_RE.exec(content)?.[1];
    if (recorded === live) return { file, stateHash: live, regenerated: false, content };
  }
  const written = writeHandoff(opts);
  return { ...written, regenerated: true };
}

/** Default size of the prose tail {@link boundedHandoffView} keeps, in characters. */
export const HANDOFF_PROSE_TAIL_CHARS = 8000;

/**
 * The bounded view of a handoff file (AISDLC-889): the generated block first, then
 * the last `tail` characters (cut at a line boundary) of the prose outside the
 * markers, then the file path. Notes are appended at the end of the file, so the
 * newest prose is what survives the cut.
 */
export function boundedHandoffView(
  content: string,
  file: string,
  tail: number = HANDOFF_PROSE_TAIL_CHARS,
): string {
  const start = content.indexOf(HANDOFF_BEGIN);
  const end = content.indexOf(HANDOFF_END);
  let block = '';
  let prose = content;
  if (start !== -1 && end !== -1 && end >= start) {
    block = content.slice(start, end + HANDOFF_END.length);
    prose = content.slice(0, start) + content.slice(end + HANDOFF_END.length);
  }
  prose = prose.trim();
  if (prose.length > tail) {
    const cut = prose.slice(prose.length - tail);
    const nl = cut.indexOf('\n');
    prose = `[earlier notes omitted; use --full]\n${nl === -1 ? cut : cut.slice(nl + 1)}`.trimEnd();
  }
  return [block, prose, file].filter((p) => p).join('\n\n');
}
