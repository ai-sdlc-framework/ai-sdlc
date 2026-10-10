/**
 * Hermetic tests for automatic context clearing (AISDLC-766): usage parsing, role
 * thresholds, executor deferral, debounce, and the `auto-clear` CLI command.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import { claimNext, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  decideAutoClear,
  markScheduled,
  readContextTokens,
  resolveThresholds,
} from './auto-clear.js';
import type { IdentityDeps } from './caller-identity.js';
import { writeRoster } from './roster.js';
import type { CommandResult, RosterEntry } from './types.js';

let tmp: string;
let board: string;
let transcript: string;

const usageLine = (input: number, cacheRead = 0, cacheCreate = 0): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: 50,
      },
    },
  });

const setTranscript = (...lines: string[]): void => {
  writeFileSync(transcript, lines.join('\n') + '\n');
};

const rosterEntry = (role: RosterEntry['role'], name: string, pane: string): RosterEntry => ({
  role,
  name,
  tmuxSession: 'ai-sdlc-hierarchy',
  tmuxWindow: name,
  paneId: pane,
  pid: 4242,
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
  tmp = mkdtempSync(path.join(tmpdir(), 'auto-clear-'));
  board = path.join(tmp, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  transcript = path.join(tmp, 't.jsonl');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('readContextTokens', () => {
  it('sums input and cache tokens of the newest usage entry', () => {
    setTranscript(usageLine(1000), '{"type":"user"}', usageLine(10, 90_000, 5_000));
    expect(readContextTokens(transcript)).toBe(95_010);
  });
  it('is null for a missing file or a transcript without usage', () => {
    expect(readContextTokens(path.join(tmp, 'nope'))).toBeNull();
    setTranscript('{"type":"user"}', 'not json "usage"');
    expect(readContextTokens(transcript)).toBeNull();
  });
});

describe('resolveThresholds', () => {
  it('defaults to planner 150k, dispatch 120k, executor 120k', () => {
    expect(resolveThresholds(board)).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
    expect(DEFAULT_CONTEXT_THRESHOLDS).toEqual({
      planner: 150_000,
      'operator-dispatch': 120_000,
      executor: 120_000,
    });
  });
  it('takes valid overrides from the board config and ignores invalid ones', () => {
    writeFileSync(
      path.join(board, 'config.json'),
      JSON.stringify({
        contextThresholds: { planner: 90000, executor: -5, 'operator-dispatch': 'x' },
      }),
    );
    expect(resolveThresholds(board)).toEqual({
      planner: 90_000,
      'operator-dispatch': 120_000,
      executor: 120_000,
    });
    writeFileSync(path.join(board, 'config.json'), '{broken');
    expect(resolveThresholds(board)).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
  });
});

describe('decideAutoClear', () => {
  const base = (role: 'planner' | 'operator-dispatch' | 'executor', name = 'p-exec') => ({
    boardDir: board,
    role,
    name,
    transcriptPath: transcript,
  });

  it('does nothing under the role threshold, clears over it', () => {
    setTranscript(usageLine(130_000));
    expect(decideAutoClear(base('planner')).action).toBe('none'); // 130k < 150k
    expect(decideAutoClear(base('operator-dispatch', 'd')).action).toBe('clear'); // > 120k
    setTranscript(usageLine(151_000));
    expect(decideAutoClear(base('planner', 'p')).action).toBe('clear');
  });

  it('does nothing without usage', () => {
    setTranscript('{"type":"user"}');
    expect(decideAutoClear(base('executor')).action).toBe('none');
  });

  it('defers an executor that holds a task, then clears it after the verdict', () => {
    setTranscript(usageLine(200_000));
    writeManifest(board, manifest('AISDLC-9'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'p-exec' });
    const held = decideAutoClear(base('executor'));
    expect(held).toMatchObject({ action: 'defer', taskId: 'AISDLC-9' });
    rmSync(path.join(board, 'inflight'), { recursive: true, force: true });
    mkdirSync(path.join(board, 'inflight'));
    expect(decideAutoClear(base('executor')).action).toBe('clear');
  });

  it('does not schedule twice inside the debounce window', () => {
    setTranscript(usageLine(200_000));
    markScheduled(board, 'd');
    expect(decideAutoClear(base('operator-dispatch', 'd'))).toMatchObject({
      action: 'none',
      reason: 'a clear is already scheduled',
    });
  });
});

describe('cli-hierarchy auto-clear', () => {
  const identity = (role: string, name: string): IdentityDeps => ({
    readSessions: () => [{ name, role, pid: 4242, status: 'running' }],
    parentPid: () => null,
    comm: () => 'claude',
    startPid: 4242,
  });

  async function run(
    role: RosterEntry['role'],
    name: string,
    pane: string,
    resumeSeen: string[],
  ): Promise<{ code: number; out: string[] }> {
    writeRoster(board, { schemaVersion: 'v1', sessions: [rosterEntry(role, name, pane)] });
    const out: string[] = [];
    const runner = (_f: string, args: readonly string[]): CommandResult => {
      const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'list-windows') return ok(`${name}\n`);
      if (args[0] === 'display-message') return ok(`${pane}\n`);
      return ok();
    };
    const code = await runHierarchyCli(
      ['auto-clear', '--transcript', transcript],
      { boardDir: board, cwd: tmp, log: (l) => out.push(l), run: runner, env: {} },
      { identity: identity(role, name) },
    );
    resumeSeen.push(...out);
    return { code, out };
  }

  it('is a no-op for a session that is not in the roster', async () => {
    setTranscript(usageLine(500_000));
    const out: string[] = [];
    const code = await runHierarchyCli(
      ['auto-clear', '--transcript', transcript],
      { boardDir: board, cwd: tmp, log: (l) => out.push(l) },
      {
        identity: {
          readSessions: () => [],
          parentPid: () => null,
          comm: () => 'claude',
          startPid: 1,
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ action: 'none' });
  });

  it('requires --transcript', async () => {
    const code = await runHierarchyCli(['auto-clear'], { boardDir: board, cwd: tmp });
    expect(code).toBe(2);
  });

  it('under the threshold schedules nothing', async () => {
    setTranscript(usageLine(10_000));
    const r = await run('planner', 'p-planner', '%2', []);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ action: 'none', reason: 'under the threshold' });
  });

  it('over the threshold writes the handoff and schedules the clear for the planner', async () => {
    setTranscript(usageLine(160_000));
    const r = await run('planner', 'p-planner', '%2', []);
    expect(r.code).toBe(0);
    const last = JSON.parse(r.out[r.out.length - 1]!);
    expect(last).toMatchObject({ action: 'clear', scheduled: { self: 'p-planner', paneId: '%2' } });
    expect(last.handoff).toMatch(/project_planner_handoff_\d{4}_\d{2}_\d{2}\.md$/);
  });
});
