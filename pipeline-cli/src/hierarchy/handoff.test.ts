/**
 * Hermetic tests for the generated handoff files (AISDLC-766): write, read, staleness
 * and the clear-and-resume contract. A temp repository holds the board; no session runs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import {
  HANDOFF_BEGIN,
  HANDOFF_END,
  boundedHandoffView,
  RESUME_COMMANDS,
  readHandoff,
  writeHandoff,
} from './handoff.js';
import { writeRoster } from './roster.js';
import type { RosterEntry } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let repo: string;
let board: string;
const NOW = () => new Date('2026-10-09T12:00:00.000Z');

const session = (role: RosterEntry['role'], name: string): RosterEntry => ({
  role,
  name,
  tmuxSession: name,
  tmuxWindow: name,
  paneId: '%1',
  pid: 1,
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  startedAt: '2026-10-09T10:00:00.000Z',
  status: 'running',
});

const manifest = (taskId: string): DispatchManifest => ({
  schemaVersion: 'v1',
  taskId,
  branch: `ai-sdlc/${taskId.toLowerCase()}`,
  worktree: `.worktrees/${taskId.toLowerCase()}`,
  baseSha: 'abc1234',
  workerKind: 'in-session-agent',
  dispatchedAt: '2026-10-09T10:00:00.000Z',
  dispatchedBy: 'test',
  spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm build'] },
});

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'handoff-'));
  board = path.join(repo, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  writeRoster(board, {
    schemaVersion: 'v1',
    sessions: [
      session('planner', 'p-planner'),
      session('operator-dispatch', 'p-dispatch'),
      session('executor', 'p-exec'),
    ],
  });
  writeManifest(board, manifest('AISDLC-1'));
});

afterEach(() => removeFixtureDir(repo));

describe('handoff write', () => {
  it('writes the dispatch handoff under the board from board state', () => {
    const r = writeHandoff({
      role: 'operator-dispatch',
      name: 'p-dispatch',
      boardDir: board,
      now: NOW,
    });
    expect(r.file).toBe(path.join(board, 'handoff', 'p-dispatch.md'));
    expect(r.content).toContain('Queue, eligible: AISDLC-1');
    expect(r.content).toContain(`Resume command: \`${RESUME_COMMANDS['operator-dispatch']}\``);
    expect(r.content).toContain('Run one `cli-hierarchy tick`');
  });

  it('writes the planner handoff to the dated memory file and keeps text outside the markers', () => {
    const first = writeHandoff({ role: 'planner', name: 'p-planner', boardDir: board, now: NOW });
    expect(first.file).toBe(
      path.join(repo, '.claude', 'memory', 'project_planner_handoff_2026_10_09.md'),
    );
    expect(RESUME_COMMANDS.planner).toBe('/ai-sdlc:planner');
    const notes = `my notes\n\n${readFileSync(first.file, 'utf-8')}\ntrailing notes\n`;
    writeFileSync(first.file, notes);
    writeManifest(board, manifest('AISDLC-2'));
    // a later day starts a new dated file that carries the text outside the markers
    const second = writeHandoff({
      role: 'planner',
      name: 'p-planner',
      boardDir: board,
      now: () => new Date('2026-10-12T00:00:00.000Z'),
    });
    expect(second.file).toBe(
      path.join(repo, '.claude', 'memory', 'project_planner_handoff_2026_10_12.md'),
    );
    // prose before the markers is rolled into the archive file (AISDLC-933)
    expect(second.content).not.toContain('my notes');
    expect(readFileSync(second.archiveFile!, 'utf-8')).toContain('my notes');
    expect(second.content).toContain('trailing notes');
    expect(second.content).toContain('AISDLC-2');
    expect(second.content.split(HANDOFF_BEGIN)).toHaveLength(2);
    expect(second.content.split(HANDOFF_END)).toHaveLength(2);
    const index = readFileSync(path.join(repo, '.claude', 'memory', 'MEMORY.md'), 'utf-8');
    expect(index).toContain('(project_planner_handoff_2026_10_12.md)');
    expect(index).not.toContain('2026_10_09');
    // a same-day rewrite keeps the index unchanged
    writeHandoff({
      role: 'planner',
      name: 'p-planner',
      boardDir: board,
      now: () => new Date('2026-10-12T05:00:00.000Z'),
    });
    expect(readFileSync(path.join(repo, '.claude', 'memory', 'MEMORY.md'), 'utf-8')).toBe(index);
  });

  it('refuses an unsafe session name', () => {
    expect(() =>
      writeHandoff({ role: 'executor', name: '../escape', boardDir: board, now: NOW }),
    ).toThrow(/not a valid session name/);
  });
});

describe('handoff read', () => {
  it('returns a current file unchanged', () => {
    writeHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    const r = readHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    expect(r.regenerated).toBe(false);
  });

  it('creates the file when it is missing', () => {
    const r = readHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    expect(r.regenerated).toBe(true);
    expect(r.content).toContain('run `cli-hierarchy executor-start`'.replace('run ', 'Run '));
  });

  it('never reads a stale file as current: a state change regenerates it', () => {
    writeHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    claimNext(board, 'in-session-agent', undefined, { workerId: 'p-exec' });
    const r = readHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    expect(r.regenerated).toBe(true);
    expect(r.content).toContain('You hold AISDLC-1');
    expect(r.content).not.toContain('Queue, eligible: AISDLC-1');
  });

  it('clear mid-tick then resume gives the same next action', () => {
    const before = writeHandoff({
      role: 'operator-dispatch',
      name: 'p-dispatch',
      boardDir: board,
      now: NOW,
    });
    // the context is cleared: nothing survives but the file and the board
    const after = readHandoff({
      role: 'operator-dispatch',
      name: 'p-dispatch',
      boardDir: board,
      now: NOW,
    });
    const action = (c: string): string => /## Next action\n(.*)\n/.exec(c)![1]!;
    expect(after.regenerated).toBe(false);
    expect(action(after.content)).toBe(action(before.content));
  });

  it('regenerates a file whose hash line was damaged', () => {
    const w = writeHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    writeFileSync(w.file, 'garbage');
    const r = readHandoff({ role: 'executor', name: 'p-exec', boardDir: board, now: NOW });
    expect(r.regenerated).toBe(true);
    expect(r.content).toContain(HANDOFF_BEGIN);
  });
});

describe('handoff bounded view and marker placement (AISDLC-889)', () => {
  it('prints block first, then the newest prose tail on a line boundary, then the path', () => {
    const block = `${HANDOFF_BEGIN}\n<!-- state-hash: ${'a'.repeat(64)} -->\n${HANDOFF_END}`;
    const old = Array.from({ length: 2000 }, (_, i) => `old note ${i}`).join('\n');
    const content = `---\nname: x\n---\n${block}\n${old}\nNEWEST NOTE\n`;
    const view = boundedHandoffView(content, '/f.md');
    expect(view.startsWith(HANDOFF_BEGIN)).toBe(true);
    expect(view.endsWith('/f.md')).toBe(true);
    expect(view).toContain('NEWEST NOTE');
    expect(view).not.toContain('old note 0\n');
    expect(view.length).toBeLessThan(8000 + block.length + 200);
    const tail = view.slice(view.indexOf(HANDOFF_END) + HANDOFF_END.length);
    expect(tail).toMatch(/omitted; use --full\]\nold note \d+\n/);
  });

  it('shows short prose whole', () => {
    expect(boundedHandoffView('just notes\n', '/f.md')).toBe('just notes\n\n/f.md');
  });

  it('places a new block right after the frontmatter, not at the end', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ho-fm-'));
    const file = path.join(dir, 'h.md');
    writeFileSync(file, '---\nname: planner\n---\nsome notes\n', 'utf-8');
    const board = path.join(dir, '.ai-sdlc', 'dispatch');
    mkdirSync(board, { recursive: true });
    const r = writeHandoff({ role: 'executor', name: 'e', boardDir: board, now: NOW, file });
    const fmEnd = r.content.indexOf('---\n', 4) + 4;
    expect(r.content.indexOf(HANDOFF_BEGIN)).toBe(fmEnd);
    expect(r.content.endsWith('some notes\n')).toBe(true);
    removeFixtureDir(dir);
  });
});

describe('handoff archive of older notes (AISDLC-933)', () => {
  const setup = (): { dir: string; file: string; archive: string; board: string } => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ho-arch-'));
    const board = path.join(dir, '.ai-sdlc', 'dispatch');
    mkdirSync(board, { recursive: true });
    const file = path.join(dir, 'planner.md');
    writeFileSync(
      file,
      [
        '---',
        'name: planner',
        '---',
        '# Title',
        'loose prose',
        '',
        HANDOFF_BEGIN,
        HANDOFF_END,
        '',
        '## RESUME HERE one',
        'first',
        '',
        '## Other',
        'keep me',
        '',
        '## RESUME HERE two',
        'second',
        '',
        '## RESUME HERE three',
        'third',
        '',
      ].join('\n'),
      'utf-8',
    );
    return { dir, file, archive: path.join(dir, 'planner_archive.md'), board };
  };

  it('keeps one block, archives the rest and loose prose, and is idempotent', () => {
    const { dir, file, archive, board } = setup();
    const o = { role: 'planner' as const, boardDir: board, now: NOW, file };
    const r = writeHandoff(o);
    expect(r.archivedBlocks).toBe(3);
    expect(r.archiveFile).toBe(archive);
    const live = readFileSync(file, 'utf-8');
    expect(live.match(/## RESUME HERE/g)).toHaveLength(1);
    expect(live).toContain('## RESUME HERE three');
    expect(live).toContain('keep me');
    expect(live).not.toContain('loose prose');
    expect(live.indexOf('# Title')).toBeLessThan(live.indexOf(HANDOFF_BEGIN));
    expect(live.slice(live.indexOf('# Title')).split('\n')[1]).toBe(HANDOFF_BEGIN);
    const arch = readFileSync(archive, 'utf-8');
    expect(arch).toContain('loose prose');
    expect(arch).toContain('## RESUME HERE one');
    expect(arch).toContain('## RESUME HERE two');
    const again = writeHandoff(o);
    expect(again.archivedBlocks).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe(live);
    expect(readFileSync(archive, 'utf-8')).toBe(arch);
    removeFixtureDir(dir);
  });

  it('--no-archive writes the block only', () => {
    const { dir, file, archive, board } = setup();
    const before = readFileSync(file, 'utf-8');
    const r = writeHandoff({ role: 'planner', boardDir: board, now: NOW, file, archive: false });
    expect(r.archivedBlocks).toBeUndefined();
    expect(readFileSync(file, 'utf-8').match(/## RESUME HERE/g)).toHaveLength(3);
    expect(existsSync(archive)).toBe(false);
    expect(before).toContain('loose prose');
    removeFixtureDir(dir);
  });
});
