import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PR_STATES, type PrState } from './pr-state.js';
import {
  actionCommands,
  commandExecutor,
  decide,
  detectKind,
  DOCS_ACTIONS,
  gatherFacts,
  listLanding,
  normaliseCheck,
  readLanding,
  reconcile,
  summariseLanding,
  taskIdFrom,
  TASK_ACTIONS,
  type ActionContext,
  type ReconcilePr,
} from './reconcile.js';
import type { CommandRunner } from './types.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

const fixedNow = () => new Date('2026-10-14T00:00:00.000Z');
const green = [{ name: 'ai-sdlc/pr-ready', conclusion: 'success' as const }];

const taskPr = (over: Partial<ReconcilePr> = {}): ReconcilePr => ({
  prNumber: 10,
  taskId: 'AISDLC-1',
  title: 'feat: x (AISDLC-1)',
  headBranch: 'ai-sdlc/aisdlc-1-x',
  headSha: 'abc123',
  draft: false,
  mergeStateStatus: 'CLEAN',
  checks: green,
  ...over,
});
const docsPr = (over: Partial<ReconcilePr> = {}): ReconcilePr => ({
  prNumber: 20,
  taskId: '',
  title: 'chore(docs): file x',
  headBranch: 'ai-sdlc/file-x',
  headSha: 'def456',
  draft: false,
  mergeStateStatus: 'CLEAN',
  checks: green,
  ...over,
});

describe('reconcile idempotency (AC1)', () => {
  it('writes one record per PR and changes nothing on a second pass', () => {
    const execute = vi.fn(() => ({ ran: true }));
    const facts = [
      taskPr({
        checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'test x failed' }],
      }),
      docsPr({ mergeStateStatus: 'DIRTY' }),
    ];
    const first = reconcile(facts, { boardDir: board, execute, now: fixedNow });
    expect(first.records).toHaveLength(2);
    expect(listLanding(board).map((r) => r.pr)).toEqual([10, 20]);
    const before = readFileSync(path.join(board, 'landing', '10.json'), 'utf-8');
    expect(execute).toHaveBeenCalledTimes(2);

    const second = reconcile(facts, {
      boardDir: board,
      execute,
      now: () => new Date('2027-01-01T00:00:00Z'),
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(second.acted).toEqual([]);
    expect(readFileSync(path.join(board, 'landing', '10.json'), 'utf-8')).toBe(before);
    expect(readLanding(board, 10)?.history).toHaveLength(1);
  });

  it('appends history and runs the new action when the head SHA changes', () => {
    const execute = vi.fn(() => ({ ran: true }));
    const red = [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' as const, summary: 'boom' }];
    reconcile([taskPr({ checks: red })], { boardDir: board, execute, now: fixedNow });
    reconcile([taskPr({ checks: red, headSha: 'new' })], {
      boardDir: board,
      execute,
      now: fixedNow,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(readLanding(board, 10)?.history).toHaveLength(2);
  });
});

describe('action table (AC2)', () => {
  const taskFacts: Record<PrState, ReconcilePr> = {
    merged: taskPr({ merged: true }),
    'manifest-branch-mismatch': taskPr({ manifestBranch: 'other' }),
    'stale-claim': taskPr({ claimHeartbeatAgeMs: 99 * 60_000 }),
    'behind-or-dirty': taskPr({ mergeStateStatus: 'BEHIND' }),
    'attestation-content-hash-mismatch': taskPr({
      checks: [
        { name: 'ai-sdlc/attestation', conclusion: 'failure', summary: 'content hash mismatch' },
      ],
    }),
    'real-failure': taskPr({
      checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'x' }],
    }),
    'cancelled-or-infra': taskPr({ checks: [{ name: 'ci', conclusion: 'cancelled' }] }),
    'ready-to-flip': taskPr({ draft: true, approvedVerdict: true, executorDead: true }),
    'armed-clean': taskPr({ autoMergeArmed: true }),
    pending: taskPr({ checks: [{ name: 'ci', conclusion: 'pending' }] }),
    'no-match': taskPr({ checks: [{ name: 'ci', conclusion: 'success' }], autoMergeArmed: false }),
  };

  for (const state of PR_STATES) {
    it(`task set maps ${state} to ${TASK_ACTIONS[state]}`, () => {
      const d = decide(taskFacts[state]);
      expect(d.state).toBe(state);
      expect(d.action).toBe(TASK_ACTIONS[state]);
    });
    it(`docs set has exactly one action for ${state}`, () => {
      expect(typeof DOCS_ACTIONS[state]).toBe('string');
    });
  }

  it('a docs PR that is DIRTY yields rebase-in-place', () => {
    expect(decide(docsPr({ mergeStateStatus: 'DIRTY' })).action).toBe('rebase-in-place');
  });

  it('a task PR with a real red yields reenter carrying the failing line and head SHA', () => {
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([taskFacts['real-failure']!], { boardDir: board, execute, now: fixedNow });
    const ctx = (execute.mock.calls[0] as unknown as [ActionContext])[0];
    expect(ctx.action).toBe('reenter');
    expect(ctx.headSha).toBe('abc123');
    const cmds = actionCommands({ ...ctx, failingLine: 'test x failed' }, '/bin');
    const args = cmds![0]!.args.join(' ');
    expect(args).toContain('test x failed');
    expect(args).toContain('abc123');
    expect(args).toContain('resume');
  });

  it('docs: DoR failure reruns DoR, other failure goes to the planner, green CLEAN arms', () => {
    expect(
      decide(docsPr({ checks: [{ name: 'DoR gate', conclusion: 'failure' }, ...green] })).action,
    ).toBe('rerun-dor');
    expect(
      decide(docsPr({ checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' }] })).action,
    ).toBe('route-to-planner');
    expect(decide(docsPr()).action).toBe('arm');
    expect(decide(docsPr({ autoMergeArmed: true })).action).toBe('none');
    expect(decide(docsPr({ mergeStateStatus: 'BLOCKED' })).action).toBe('route-to-planner');
  });

  it('an undelivered draft task PR is left to its executor', () => {
    const d = decide(
      taskPr({ draft: true, checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' }] }),
    );
    expect(d.action).toBe('none');
    expect(decide(taskPr({ draft: true, approvedVerdict: true })).action).toBe('none');
  });

  it('reports the release-please PR and never acts on it', () => {
    const execute = vi.fn(() => ({ ran: true }));
    const r = reconcile(
      [
        {
          prNumber: 5,
          taskId: '',
          title: 'chore: release main',
          headBranch: 'release-please--branches--main',
        },
      ],
      { boardDir: board, execute, now: fixedNow },
    );
    expect(r.reported).toEqual([{ pr: 5, title: 'chore: release main' }]);
    expect(execute).not.toHaveBeenCalled();
    expect(listLanding(board)).toEqual([]);
  });
});

describe('ownership (AC4)', () => {
  it('a filing PR is machine-owned at first sight; a task PR flips to machine when delivered', () => {
    const execute = () => ({ ran: false });
    reconcile([docsPr({ title: 'no id here' }), taskPr({ draft: true, executor: 'alpha' })], {
      boardDir: board,
      execute,
      now: fixedNow,
    });
    expect(readLanding(board, 20)).toMatchObject({ owner: 'machine', kind: 'docs' });
    expect(readLanding(board, 10)?.owner).toBe('executor:alpha');
    reconcile([taskPr({ draft: false })], { boardDir: board, execute, now: fixedNow });
    expect(readLanding(board, 10)).toMatchObject({ owner: 'machine' });
    expect(readLanding(board, 10)?.delivered).toBeDefined();
    expect(summariseLanding(board)).toContain('#20 docs');
  });

  it('marks a merged PR landed', () => {
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([taskPr({ merged: true })], { boardDir: board, execute, now: fixedNow });
    expect(readLanding(board, 10)?.landed).toBe('2026-10-14T00:00:00.000Z');
    expect(execute).not.toHaveBeenCalled();
    expect(summariseLanding(board)).toBe('');
  });

  it('takes over from a dead executor', () => {
    reconcile([taskPr({ draft: true, approvedVerdict: true, executorDead: true })], {
      boardDir: board,
      execute: () => ({ ran: true }),
      now: fixedNow,
    });
    expect(readLanding(board, 10)).toMatchObject({
      owner: 'machine',
      action: 'flip-ready-takeover',
    });
  });
});

describe('helpers', () => {
  it('detects kinds and task ids', () => {
    expect(detectKind({ headBranch: 'docs/x', taskId: 'A-1' })).toBe('docs');
    expect(detectKind({ headBranch: 'ai-sdlc/decisions-sync-1' })).toBe('docs');
    expect(detectKind({ taskId: 'A-1' })).toBe('task');
    expect(detectKind({ title: 'chore: release main' })).toBe('release');
    expect(taskIdFrom('ai-sdlc/aisdlc-12.3-foo')).toBe('AISDLC-12.3');
    expect(taskIdFrom('x', 'fix: y (AISDLC-9)')).toBe('AISDLC-9');
    expect(taskIdFrom('x', 'nothing')).toBe('');
  });

  it('normalises checks', () => {
    expect(
      normaliseCheck({ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }).conclusion,
    ).toBe('success');
    expect(normaliseCheck({ name: 'a', status: 'IN_PROGRESS' }).conclusion).toBe('pending');
    expect(normaliseCheck({ context: 'b', state: 'FAILURE', description: 'd' })).toEqual({
      name: 'b',
      conclusion: 'failure',
      summary: 'd',
    });
    expect(normaliseCheck({ name: 'a', conclusion: 'CANCELLED' }).conclusion).toBe('cancelled');
    expect(normaliseCheck({ name: 'a', conclusion: 'TIMED_OUT' }).conclusion).toBe('infra');
  });

  it('builds commands for each action', () => {
    const base: ActionContext = {
      pr: 3,
      taskId: 'AISDLC-1',
      kind: 'task',
      action: '',
      state: 'pending',
      headSha: 'sha',
      boardDir: '/b',
    };
    const run = (action: string, over: Partial<ActionContext> = {}) =>
      actionCommands({ ...base, action, ...over }, '/bin');
    expect(run('reap-resume')![0]!.args).toContain('reap');
    expect(run('flip-ready-takeover')![0]).toEqual({ file: 'gh', args: ['pr', 'ready', '3'] });
    expect(run('rebase-in-place')![0]!.args).toContain('rebase');
    expect(run('arm')![0]!.args).toContain('--arm');
    expect(run('retrigger-once')![0]!.args).toContain('sha');
    expect(run('rerun-dor', { headSha: undefined })).toBeNull();
    expect(run('land-prep')![0]!.args.join(' ')).toContain('rebase onto');
    expect(run('push-only-resign')![0]!.args.join(' ')).toContain('re-sign');
    expect(run('reenter')![0]!.args.join(' ')).toContain('a required check failed');
    expect(run('none')).toBeNull();
  });

  it('commandExecutor runs argv and reports failures', () => {
    const calls: string[] = [];
    const ok: CommandRunner = (f, a) => (
      calls.push(f + a.join(' ')),
      { status: 0, stdout: '', stderr: '' }
    );
    const bad: CommandRunner = () => ({ status: 1, stdout: '', stderr: 'nope\nmore' });
    const ctx: ActionContext = {
      pr: 3,
      taskId: 'T-1',
      kind: 'task',
      action: 'flip-ready-takeover',
      state: 'ready-to-flip',
      boardDir: '/b',
    };
    expect(commandExecutor(ok, '/', '/bin')(ctx)).toEqual({ ran: true });
    expect(commandExecutor(bad, '/', '/bin')(ctx)).toEqual({ ran: true, note: 'gh failed: nope' });
    expect(commandExecutor(ok, '/', '/bin')({ ...ctx, action: 'none' }).ran).toBe(false);
  });
});

describe('gatherFacts', () => {
  const runner =
    (responses: Record<string, string | number>): CommandRunner =>
    (_f, args) => {
      const key =
        args.slice(0, 2).join(' ') + (args[2] && /^\d+$/.test(args[2]) ? ` ${args[2]}` : '');
      const r = responses[key];
      if (r === undefined || typeof r === 'number')
        return { status: typeof r === 'number' ? r : 1, stdout: '', stderr: 'err' };
      return { status: 0, stdout: r, stderr: '' };
    };

  it('returns undefined when the list cannot be read', () => {
    expect(gatherFacts(runner({}), '/', board)).toBeUndefined();
    expect(gatherFacts(runner({ 'pr list': 'not json' }), '/', board)).toBeUndefined();
  });

  it('builds facts, detects docs-only and finds merged records', () => {
    reconcile([taskPr({ prNumber: 77 })], {
      boardDir: board,
      execute: () => ({ ran: false }),
      now: fixedNow,
    });
    const list = JSON.stringify([
      {
        number: 1,
        title: 'fix (AISDLC-1)',
        headRefName: 'ai-sdlc/aisdlc-1-x',
        headRefOid: 's1',
        isDraft: true,
        mergeStateStatus: 'CLEAN',
        autoMergeRequest: { x: 1 },
        files: [{ path: 'docs/a.md' }],
      },
      { number: 2 },
    ]);
    const facts = gatherFacts(
      runner({
        'pr list': list,
        'pr view 1': JSON.stringify({
          statusCheckRollup: [{ name: 'c', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        'pr view 2': 'bad',
        'pr view 77': JSON.stringify({ state: 'MERGED' }),
      }),
      '/',
      board,
    )!;
    expect(facts[0]).toMatchObject({
      prNumber: 1,
      taskId: 'AISDLC-1',
      docsOnly: true,
      autoMergeArmed: true,
      draft: true,
    });
    expect(facts[0]!.checks).toHaveLength(1);
    expect(facts[1]).toMatchObject({ prNumber: 2, docsOnly: false, checks: [] });
    expect(facts.find((f) => f.prNumber === 77)).toMatchObject({ merged: true });
  });
});
