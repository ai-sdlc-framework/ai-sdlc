/**
 * Hermetic tests for the generated handoff files (AISDLC-766): write, read, staleness
 * and the clear-and-resume contract. A temp repository holds the board; no session runs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import {
  HANDOFF_BEGIN,
  HANDOFF_END,
  RESUME_COMMANDS,
  readHandoff,
  writeHandoff,
} from './handoff.js';
import { writeRoster } from './roster.js';
import type { RosterEntry } from './types.js';

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

afterEach(() => rmSync(repo, { recursive: true, force: true }));

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
    // a later day still reuses the existing dated file
    const second = writeHandoff({
      role: 'planner',
      name: 'p-planner',
      boardDir: board,
      now: () => new Date('2026-10-12T00:00:00.000Z'),
    });
    expect(second.file).toBe(first.file);
    expect(second.content).toContain('my notes');
    expect(second.content).toContain('trailing notes');
    expect(second.content).toContain('AISDLC-2');
    expect(second.content.split(HANDOFF_BEGIN)).toHaveLength(2);
    expect(second.content.split(HANDOFF_END)).toHaveLength(2);
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
