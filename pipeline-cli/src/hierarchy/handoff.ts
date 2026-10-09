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
}

/** Result of a write or read. */
export interface HandoffResult {
  file: string;
  stateHash: string;
  /** read: the file was missing or stale and was regenerated first. */
  regenerated: boolean;
  content: string;
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
  return { roster, board, inflight, openDecisions };
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
    const existing = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^project_planner_handoff_[0-9_]+\.md$/.test(f))
          .sort()
          .pop()
      : undefined;
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '_');
    return path.join(dir, existing ?? `project_planner_handoff_${stamp}.md`);
  }
  return path.join(opts.boardDir, 'handoff', `${name}.md`);
}

function splice(existing: string | undefined, block: string): string {
  if (!existing) return block;
  const start = existing.indexOf(HANDOFF_BEGIN);
  const end = existing.indexOf(HANDOFF_END);
  if (start === -1 || end === -1 || end < start) return existing.replace(/\s*$/, '\n\n') + block;
  return existing.slice(0, start) + block.trimEnd() + existing.slice(end + HANDOFF_END.length);
}

/** Generate the handoff from live state and write it. */
export function writeHandoff(opts: HandoffOptions): HandoffResult {
  const now = (opts.now ?? clock)();
  const name = opts.name ?? opts.role;
  const file = handoffPath(opts, now);
  const state = collectHandoffState(opts.boardDir, () => now);
  const block = renderHandoff(opts.role, name, state, now.toISOString());
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : undefined;
  const content = splice(existing, block);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
  return { file, stateHash: hashHandoffState(state), regenerated: false, content };
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
