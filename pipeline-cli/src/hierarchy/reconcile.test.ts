import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimNext, collectVerdicts, writeManifest, writeVerdict } from '../dispatch/board.js';
import { completeTask } from '../dispatch/complete.js';
import { PR_STATES, type PrState } from './pr-state.js';
import {
  actionCommands,
  commandExecutor,
  decide,
  detectKind,
  DOCS_ACTIONS,
  allowedAuthors,
  gatherFacts,
  gatherMainHealth,
  prBelongsToTask,
  listLanding,
  normaliseCheck,
  readLanding,
  reconcile,
  summariseLanding,
  takeSuppressedNote,
  taskIdFrom,
  TASK_ACTIONS,
  type ActionContext,
  type LandingRecord,
  type ReconcilePr,
} from './reconcile.js';
import type { CommandRunner } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
});
afterEach(() => removeFixtureDir(board));

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
      now: () => new Date('2026-10-14T01:00:00Z'),
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(second.acted).toEqual([]);
    expect(readFileSync(path.join(board, 'landing', '10.json'), 'utf-8')).toBe(before);
    expect(readLanding(board, 10)?.history).toHaveLength(1);
  });

  it('retries a failed action on the next pass without a new history entry', () => {
    const red = [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' as const, summary: 'boom' }];
    const execute = vi
      .fn<(c: ActionContext) => { ran: boolean; failed?: boolean }>()
      .mockReturnValueOnce({ ran: true, failed: true })
      .mockReturnValue({ ran: true });
    const facts = [taskPr({ checks: red })];
    reconcile(facts, { boardDir: board, execute, now: fixedNow });
    expect(readLanding(board, 10)?.actionFailed).toBe(true);
    const second = reconcile(facts, { boardDir: board, execute, now: fixedNow });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(second.acted).toHaveLength(1);
    expect(readLanding(board, 10)?.actionFailed).toBeUndefined();
    expect(readLanding(board, 10)?.history).toHaveLength(1);
    reconcile(facts, { boardDir: board, execute, now: fixedNow });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  describe('failed-action retry loop (AISDLC-1125)', () => {
    const red = [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' as const, summary: 'boom' }];
    const failing = () =>
      vi.fn<(c: ActionContext) => { ran: boolean; failed?: boolean }>(() => ({
        ran: true,
        failed: true,
      }));
    const routes = (r: { acted: { action: string; pr: number }[] }) =>
      r.acted.filter((a) => a.action === 'route-to-planner');

    it('routes once after a second failure on the same head and stops retrying', () => {
      const execute = failing();
      const facts = [taskPr({ checks: red })];
      const t = (h: number) => () => new Date(`2026-10-14T0${h}:00:00.000Z`);
      const p1 = reconcile(facts, { boardDir: board, execute, now: t(0) });
      expect(routes(p1)).toHaveLength(0);
      const p2 = reconcile(facts, { boardDir: board, execute, now: t(1) });
      expect(routes(p2)).toHaveLength(1);
      expect(routes(p2)[0]).toMatchObject({ pr: 10 });
      expect(JSON.stringify(routes(p2)[0])).toContain('abc123');
      expect(JSON.stringify(routes(p2)[0])).toContain('failed x2');
      expect(readLanding(board, 10)?.lastActionAt).toBe('2026-10-14T01:00:00.000Z');
      const p3 = reconcile(facts, { boardDir: board, execute, now: t(2) });
      expect(routes(p3)).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('re-runs once on a new head after a failure', () => {
      const execute = failing();
      reconcile([taskPr({ checks: red })], { boardDir: board, execute, now: fixedNow });
      reconcile([taskPr({ checks: red, headSha: 'new999' })], {
        boardDir: board,
        execute,
        now: fixedNow,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1]![0].headSha).toBe('new999');
    });

    it('a failed record still reaches the aging cap', () => {
      const execute = failing();
      const facts = [taskPr({ checks: red })];
      reconcile(facts, { boardDir: board, execute, now: fixedNow });
      const rec = readLanding(board, 10)!;
      writeFileSync(
        path.join(board, 'landing', '10.json'),
        JSON.stringify({ ...rec, agedAttempts: 3 }),
      );
      const later = () => new Date('2026-10-14T12:00:00.000Z');
      const r = reconcile(facts, { boardDir: board, execute, now: later });
      expect(routes(r)).toHaveLength(1);
      expect(JSON.stringify(routes(r)[0])).toContain('failed');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('replays frozen failed records (agedAttempts 2) to the planner on the first pass', () => {
      const execute = failing();
      for (const pr of [2093, 2127, 2129]) {
        const f = taskPr({ prNumber: pr, taskId: `AISDLC-${pr}`, checks: red });
        reconcile([f], { boardDir: board, execute, now: fixedNow });
        const rec = readLanding(board, pr)!;
        const { failedAttempts: _drop, ...old } = rec;
        writeFileSync(
          path.join(board, 'landing', `${pr}.json`),
          JSON.stringify({
            ...old,
            actionFailed: true,
            agedAttempts: 2,
            lastActionAt: '2026-10-29T00:00:00.000Z',
          }),
        );
      }
      const facts = [2093, 2127, 2129].map((pr) =>
        taskPr({ prNumber: pr, taskId: `AISDLC-${pr}`, checks: red }),
      );
      const r = reconcile(facts, { boardDir: board, execute, now: fixedNow });
      expect(
        routes(r)
          .map((a) => a.pr)
          .sort(),
      ).toEqual([2093, 2127, 2129]);
    });
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

describe('manifest-branch-mismatch (AISDLC-901)', () => {
  it('rewrites a queued manifest even while the PR is a draft, and only reports an inflight one', () => {
    const queued = decide(
      taskPr({ draft: true, manifestBranch: 'ai-sdlc/aisdlc-1', manifestState: 'queue' }),
    );
    expect(queued).toMatchObject({ state: 'manifest-branch-mismatch', action: 'rewrite-manifest' });
    const inflight = decide(
      taskPr({ draft: true, manifestBranch: 'ai-sdlc/aisdlc-1', manifestState: 'inflight' }),
    );
    expect(inflight.action).toBe('report-only');
    const ctx: ActionContext = {
      pr: 10,
      taskId: 'AISDLC-1',
      kind: 'task',
      action: 'rewrite-manifest',
      state: 'manifest-branch-mismatch',
      boardDir: board,
    };
    const cmds = actionCommands(ctx, '/bin');
    expect(cmds?.[0]?.args).toContain('--from-pr');
    expect(cmds?.[0]?.args).toContain('write-manifest');
  });

  it('tick auto-repair: reconcile runs the rewrite for a queued mismatch and records it', () => {
    const execute = vi.fn(() => ({ ran: true }));
    const report = reconcile(
      [taskPr({ draft: true, manifestBranch: 'ai-sdlc/aisdlc-1', manifestState: 'queue' })],
      { boardDir: board, execute, now: fixedNow },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.acted[0]).toMatchObject({ pr: 10, action: 'rewrite-manifest', ran: true });
  });
});

describe('action table (AC2)', () => {
  const taskFacts: Record<PrState, ReconcilePr> = {
    merged: taskPr({ merged: true }),
    'manifest-branch-mismatch': taskPr({ manifestBranch: 'other' }),
    'behind-or-dirty': taskPr({ mergeStateStatus: 'BEHIND' }),
    'attestation-content-hash-mismatch': taskPr({
      checks: [
        { name: 'ai-sdlc/attestation', conclusion: 'failure', summary: 'content hash mismatch' },
      ],
    }),
    'rate-limited': taskPr({
      checks: [
        {
          name: 'ai-sdlc/pr-ready',
          conclusion: 'failure',
          summary: 'API rate limit exceeded for installation',
        },
      ],
    }),
    'real-failure': taskPr({
      checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'x' }],
    }),
    'cancelled-or-infra': taskPr({ checks: [{ name: 'ci', conclusion: 'cancelled' }] }),
    'ready-to-flip': taskPr({ draft: true, approvedVerdict: true, executorDead: true }),
    'armed-clean': taskPr({ autoMergeArmed: true }),
    pending: taskPr({ checks: [{ name: 'ci', conclusion: 'pending' }] }),
    'no-match': taskPr({
      checks: [{ name: 'ci', conclusion: 'success' }],
      autoMergeArmed: false,
      mergeStateStatus: 'BLOCKED',
    }),
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
    // `reenter` reads the head and the failing line from the PR itself.
    expect(args).toContain('reenter');
    expect(args).not.toContain('resume');
  });

  it('a coverage or failing-test red reenters with a developer round (AISDLC-1093)', () => {
    const base = {
      pr: 7,
      taskId: 'T-1',
      kind: 'task',
      action: 'reenter',
      state: 'real-failure',
      boardDir: 'b',
    } as unknown as ActionContext;
    for (const line of [
      '[patch-coverage] FAIL: patch coverage 87.27% < 89% threshold. low: a.ts',
      '3 tests failed',
    ]) {
      const args = actionCommands({ ...base, failingLine: line }, '/bin')![0]!.args;
      expect(args).toContain('--developer-round');
      expect(args[args.indexOf('--note') + 1]).toContain(line);
    }
    expect(actionCommands({ ...base, failingLine: 'lint broke' }, '/bin')![0]!.args).not.toContain(
      '--developer-round',
    );
    expect(actionCommands({ ...base }, '/bin')![0]!.args).not.toContain('--developer-round');
    expect(
      actionCommands({ ...base, action: 'push-only-resign', failingLine: 'coverage' }, '/bin')![0]!
        .args,
    ).not.toContain('--developer-round');
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

  it('decisions-sync: armed with its own source kind, never routed on a green CLEAN head, re-armed on head change', () => {
    const sync = (over: Partial<ReconcilePr> = {}) =>
      docsPr({ headBranch: 'ai-sdlc/decisions-sync', title: 'chore: sync decisions', ...over });
    const d = decide(sync());
    expect(d).toMatchObject({ kind: 'decisions-sync', action: 'arm' });
    const ctx: ActionContext = {
      pr: 20,
      taskId: '',
      kind: 'decisions-sync',
      action: 'arm',
      state: d.state,
      boardDir: '/b',
    };
    expect(actionCommands(ctx, '/bin')![0]!.args).toEqual([
      '/bin/cli-merge-if-eligible.mjs',
      '20',
      '--source-kind',
      'decisions-sync',
      '--arm',
    ]);
    const execute = vi.fn((_c: ActionContext) => ({ ran: true }));
    reconcile([sync()], { boardDir: board, execute, now: fixedNow });
    reconcile([sync({ headSha: 'new999' })], { boardDir: board, execute, now: fixedNow });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((c) => [c[0].kind, c[0].action, c[0].headSha])).toEqual([
      ['decisions-sync', 'arm', 'def456'],
      ['decisions-sync', 'arm', 'new999'],
    ]);
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

  it('an unownedReason fact yields owner unowned with the reason in the note (AISDLC-1091)', () => {
    const execute = () => ({ ran: false });
    reconcile([docsPr({ unownedReason: 'no lane can land this' })], {
      boardDir: board,
      execute,
      now: fixedNow,
    });
    const landing = readLanding(board, 20);
    expect(landing?.owner).toBe('unowned');
    expect(landing?.note).toContain('no lane can land this');
  });

  it('marks a merged PR landed', () => {
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([taskPr({ merged: true })], { boardDir: board, execute, now: fixedNow });
    expect(readLanding(board, 10)?.landed).toBe('2026-10-14T00:00:00.000Z');
    expect(execute).not.toHaveBeenCalled();
    expect(summariseLanding(board)).toBe('');
  });

  it('completes an inflight iterate-needed task whose PR merged and names it', () => {
    writeManifest(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-1',
      branch: 'ai-sdlc/aisdlc-1-x',
      worktree: '.worktrees/aisdlc-1',
      baseSha: 'abc1234',
      workerKind: 'in-session-agent',
      dispatchedAt: '2026-10-13T00:00:00.000Z',
      dispatchedBy: 'test',
      spec: { taskFile: 'backlog/tasks/aisdlc-1.md', verifyCommands: [] },
    });
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-1' });
    completeTask(board, {
      taskId: 'AISDLC-1',
      outcome: 'iterate-needed',
      prNumber: 10,
      workerId: 'executor-1',
    });
    const report = reconcile([taskPr({ merged: true })], {
      boardDir: board,
      execute: () => ({ ran: true }),
      now: fixedNow,
    });
    expect(report.acted).toContainEqual(
      expect.objectContaining({ pr: 10, action: 'auto-complete', ran: true }),
    );
    expect(collectVerdicts(board).find((v) => v.taskId === 'AISDLC-1')).toMatchObject({
      outcome: 'success',
      prNumber: 10,
    });
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
    expect(detectKind({ headBranch: 'ai-sdlc/decisions-sync' })).toBe('decisions-sync');
    expect(detectKind({ headBranch: 'ai-sdlc/file-x' })).toBe('docs');
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
    expect(normaliseCheck({ name: 'a', conclusion: 'SKIPPED' })).toMatchObject({
      conclusion: 'success',
      skipped: true,
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
    expect(run('flip-ready-takeover')![0]).toEqual({ file: 'gh', args: ['pr', 'ready', '3'] });
    expect(run('rebase-in-place')![0]!.args).toContain('rebase');
    expect(run('arm')![0]!.args).toContain('--arm');
    for (const a of ['retrigger-once', 'rerun-rate-limited', 'rerun-dor']) {
      const cmds = run(a)!;
      expect(cmds).toHaveLength(2);
      expect(cmds[0]!.args.slice(0, 4)).toEqual(['run', 'list', '--commit', 'sha']);
      expect(cmds[0]!.captureRunId).toBe(true);
      expect(cmds[1]!.args).toEqual(['run', 'rerun', '{runId}', '--failed']);
      expect(cmds.flatMap((c) => (c.args[1] === 'rerun' ? c.args : []))).not.toContain('--commit');
    }
    expect(run('rerun-dor', { headSha: undefined })).toBeNull();
    for (const a of ['land-prep', 'push-only-resign', 'reenter']) {
      expect(run(a)![0]!.args.slice(1, 3)).toEqual(['reenter', '3']);
    }
    expect(run('none')).toBeNull();
  });

  it('arm: source kind follows the PR (decisions-sync, backlog, else planner)', () => {
    const base: ActionContext = {
      pr: 9,
      taskId: '',
      kind: 'docs',
      action: 'arm',
      state: 'pending',
      boardDir: '/b',
    };
    expect(actionCommands({ ...base, kind: 'decisions-sync' }, '/bin')![0]!.args).toContain(
      'decisions-sync',
    );
    const backlog = actionCommands({ ...base, taskId: 'AISDLC-5' }, '/bin')![0]!.args;
    expect(backlog[backlog.indexOf('--source-kind') + 1]).toBe('backlog');
    expect(actionCommands(base, '/bin')).toBeNull();
    const r = commandExecutor(() => ({ status: 0, stdout: '', stderr: '' }), '/', '/bin')(base);
    expect(r.ran).toBe(false);
    expect(r.note).toContain('planner');
  });

  it('commandExecutor records a stdout-only refusal reason', () => {
    const out: CommandRunner = () => ({
      status: 1,
      stdout: '\nrefused: not linked\nx',
      stderr: '',
    });
    const ctx: ActionContext = {
      pr: 3,
      taskId: 'T-1',
      kind: 'task',
      action: 'flip-ready-takeover',
      state: 'ready-to-flip',
      boardDir: '/b',
    };
    expect(commandExecutor(out, '/', '/bin')(ctx).note).toBe('gh failed: refused: not linked');
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
    expect(commandExecutor(bad, '/', '/bin')(ctx)).toEqual({
      ran: true,
      failed: true,
      note: 'gh failed: nope',
    });
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
    // Authenticated user unknown: fail closed.
    expect(gatherFacts(runner({ 'pr list': '[]' }), '/', board)).toBeUndefined();
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
        isCrossRepository: false,
        author: { login: 'Me' },
        isDraft: true,
        mergeStateStatus: 'CLEAN',
        autoMergeRequest: { x: 1 },
        files: [{ path: 'docs/a.md' }],
      },
      { number: 2, isCrossRepository: false, author: { login: 'me' } },
    ]);
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-1',
      outcome: 'success',
      prNumber: 1,
      completedAt: '2026-10-14T00:00:00.000Z',
    } as never);
    const facts = gatherFacts(
      runner({
        'api user': 'me\n',
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

describe('gatherFacts trust filter', () => {
  const pr = (over: Record<string, unknown>) => ({
    number: 5,
    title: 'feat: x (AISDLC-9)',
    headRefName: 'ai-sdlc/aisdlc-9-x',
    isCrossRepository: false,
    author: { login: 'me' },
    ...over,
  });
  const run =
    (list: unknown[]): CommandRunner =>
    (_f, args) => {
      if (args[0] === 'api') return { status: 0, stdout: 'me', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(list), stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    };
  const done = (prNumber: number, prUrl?: string) =>
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-9',
      outcome: 'success',
      prNumber,
      ...(prUrl ? { prUrl } : {}),
      completedAt: '2026-10-14T00:00:00.000Z',
    } as never);

  it('skips cross-repository PRs and PRs with no recorded cross-repo flag', () => {
    done(5);
    const facts = gatherFacts(
      run([pr({ isCrossRepository: true }), pr({ number: 6, isCrossRepository: undefined })]),
      '/',
      board,
    )!;
    expect(facts).toEqual([]);
  });

  it('skips authors outside the allow-list for task and docs PRs', () => {
    done(5);
    const facts = gatherFacts(
      run([
        pr({ author: { login: 'mallory' } }),
        pr({
          number: 7,
          title: 'chore(docs): file x',
          headRefName: 'ai-sdlc/file-x',
          author: { login: 'mallory' },
        }),
      ]),
      '/',
      board,
    )!;
    // AISDLC-1091: not dropped, an unowned row with the reason.
    expect(facts.map((f) => f.unownedReason)).toEqual([
      expect.stringContaining('mallory'),
      expect.stringContaining('mallory'),
    ]);
  });

  it('owns a task PR through its branch even when the verdict lacks the PR (AISDLC-1091)', () => {
    const facts = gatherFacts(run([pr({})]), '/', board)!;
    expect(facts.map((f) => [f.prNumber, f.taskId, f.unownedReason])).toEqual([
      [5, 'AISDLC-9', undefined],
    ]);
    done(5);
    expect(gatherFacts(run([pr({})]), '/', board)!.map((f) => f.prNumber)).toEqual([5]);
  });

  it('keeps dependabot PRs as the deps kind and flags chore branches with no lane', () => {
    const facts = gatherFacts(
      run([
        pr({
          number: 20,
          title: 'Bump x',
          headRefName: 'dependabot/npm/x-1',
          author: { login: 'app/dependabot' },
        }),
        pr({ number: 21, title: 'chore: pin sync', headRefName: 'chore/pin-sync' }),
      ]),
      '/',
      board,
    )!;
    expect(facts[0]).toMatchObject({ prNumber: 20, taskId: '' });
    expect(facts[0]!.unownedReason).toBeUndefined();
    expect(facts[1]!.unownedReason).toContain('chore/pin-sync');
  });

  it('unowned PRs get the planner with a reason, never none (AISDLC-1091)', () => {
    const d = decide({ prNumber: 1, taskId: '', unownedReason: 'no lane', draft: true });
    expect(d).toMatchObject({ action: 'route-to-planner', note: 'unowned: no lane' });
  });

  it('arms a green dependabot PR with the deps source kind and updates a BEHIND one', () => {
    const green = {
      prNumber: 20,
      taskId: '',
      headBranch: 'dependabot/npm/x',
      draft: false,
      mergeStateStatus: 'CLEAN',
      autoMergeArmed: false,
      checks: [{ name: 'ci', conclusion: 'success' as const }],
    };
    expect(decide(green)).toMatchObject({ kind: 'deps', action: 'arm' });
    const ctx = {
      pr: 20,
      taskId: '',
      kind: 'deps' as const,
      action: 'arm',
      state: 'no-match' as const,
      boardDir: '/b',
    };
    expect(actionCommands(ctx, '/bin')![0]!.args).toContain('deps');
    expect(decide({ ...green, mergeStateStatus: 'BEHIND' }).action).toBe('update-branch');
    expect(actionCommands({ ...ctx, action: 'update-branch' }, '/bin')![0]!.args).toEqual([
      'pr',
      'update-branch',
      '20',
    ]);
  });

  it('a draft of a done task that is green is flipped by the reconciler alone', () => {
    const f = {
      prNumber: 24,
      taskId: 'AISDLC-9',
      headBranch: 'ai-sdlc/aisdlc-9-x',
      draft: true,
      executorDead: true,
      approvedVerdict: true,
      mergeStateStatus: 'CLEAN',
      checks: [{ name: 'ci', conclusion: 'success' as const }],
    };
    expect(decide(f).action).toBe('flip-ready-takeover');
    expect(decide({ ...f, draft: false })).toMatchObject({ action: 'arm' });
  });

  it('re-arms a green CLEAN ready task PR whose auto-merge GitHub dropped (AISDLC-1097)', () => {
    expect(decide(taskPr({ autoMergeArmed: false }))).toMatchObject({ action: 'arm' });
    expect(decide(taskPr({ autoMergeArmed: true })).action).toBe('none');
  });

  it('owns a draft of a done task and flags a draft with no claim and no verdict', () => {
    done(5);
    const doneFacts = gatherFacts(run([pr({ isDraft: true })]), '/', board)!;
    expect(doneFacts[0]).toMatchObject({ executorDead: true, approvedVerdict: true });
    const orphan = gatherFacts(
      run([
        pr({
          number: 9,
          title: 'feat: y (AISDLC-77)',
          headRefName: 'ai-sdlc/aisdlc-77-y',
          isDraft: true,
        }),
      ]),
      '/',
      board,
    )!;
    expect(orphan[0]!.unownedReason).toContain('draft task PR');
  });

  describe('draft task PR with a failed verdict (AISDLC-1139)', () => {
    const orphanRun = () =>
      run([
        pr({
          number: 9,
          title: 'feat: y (AISDLC-77)',
          headRefName: 'ai-sdlc/aisdlc-77-y',
          isDraft: true,
        }),
      ]);
    const failed = (extra: Record<string, unknown>) =>
      writeVerdict(board, {
        schemaVersion: 'v1',
        taskId: 'AISDLC-77',
        outcome: 'failed',
        completedAt: '2026-10-31T00:00:00.000Z',
        ...extra,
      } as never);

    it('reclaims a draft whose failed verdict records a signed attestation', () => {
      failed({ signedAt: '2026-10-31T00:00:00.000Z' });
      const facts = gatherFacts(orphanRun(), '/', board)!;
      expect(facts[0]!.unownedReason).toBeUndefined();
      expect(facts[0]!.reclaimable).toBe(true);
      expect(decide(facts[0]!).action).toBe('rewrite-manifest');
      expect(decide({ ...facts[0]!, manifestState: 'queue' }).action).toBe('push-only-reenter');
    });

    it('keeps an unapproved failed verdict and no verdict routed to the planner', () => {
      failed({});
      const noApproval = gatherFacts(orphanRun(), '/', board)!;
      expect(noApproval[0]!.unownedReason).toContain('draft task PR');
      expect(decide(noApproval[0]!)).toMatchObject({
        action: 'route-to-planner',
        note: expect.stringContaining('no done verdict'),
      });
    });

    it('routes a twice-failed push-only reenter on the same head to the planner', () => {
      const f: ReconcilePr = {
        prNumber: 9,
        taskId: 'AISDLC-77',
        headBranch: 'ai-sdlc/aisdlc-77-y',
        headSha: 'H',
        draft: true,
        reclaimable: true,
        manifestState: 'queue',
        checks: [],
      };
      const record = {
        pr: 9,
        kind: 'task',
        owner: 'x',
        state: 'pending',
        action: 'none',
        history: [{ ts: 't', state: 'pending', action: 'push-only-reenter', headSha: 'H' }],
      } as unknown as LandingRecord;
      expect(decide(f, record)).toMatchObject({
        action: 'route-to-planner',
        note: 'push-only-reenter@H x2',
      });
    });

    it('waits when the last pass already ran push-only reenter on this head', () => {
      const f: ReconcilePr = {
        prNumber: 9,
        taskId: 'AISDLC-77',
        headBranch: 'ai-sdlc/aisdlc-77-y',
        headSha: 'H',
        draft: true,
        reclaimable: true,
        manifestState: 'queue',
        checks: [],
      };
      const record = {
        pr: 9,
        kind: 'task',
        owner: 'x',
        state: 'pending',
        action: 'push-only-reenter',
        history: [{ ts: 't', state: 'pending', action: 'push-only-reenter', headSha: 'H' }],
      } as unknown as LandingRecord;
      expect(decide(f, record).action).toBe('none');
    });

    it('runs reenter with --push-only', () => {
      const cmds = actionCommands(
        {
          pr: 9,
          taskId: 'AISDLC-77',
          kind: 'task',
          action: 'push-only-reenter',
          state: 'pending',
          boardDir: board,
        },
        '/bin',
      );
      expect(cmds![0]!.args).toEqual(expect.arrayContaining(['reenter', '9', '--push-only']));
    });
  });

  it('keeps allowed docs PRs and same-repo release PRs', () => {
    const facts = gatherFacts(
      run([
        pr({ number: 7, title: 'chore(docs): file x', headRefName: 'ai-sdlc/file-x' }),
        pr({
          number: 9,
          title: 'chore: release main',
          headRefName: 'release-please--x',
          author: {},
        }),
      ]),
      '/',
      board,
    )!;
    expect(facts.map((f) => f.prNumber)).toEqual([7, 9]);
  });

  it('prBelongsToTask keeps the tie through a landing record after the verdict moved', () => {
    mkdirSync(path.join(board, 'landing'), { recursive: true });
    writeFileSync(
      path.join(board, 'landing', '5.json'),
      JSON.stringify({ pr: 5, kind: 'task', taskId: 'AISDLC-9' }),
    );
    expect(prBelongsToTask(board, 'AISDLC-9', 5, 'b', [])).toBe(true);
    expect(prBelongsToTask(board, 'AISDLC-8', 5, 'b', [])).toBe(false);
  });

  it('prBelongsToTask accepts a verdict url or an inflight branch', () => {
    expect(
      prBelongsToTask(board, 'AISDLC-9', 5, 'b', [
        { taskId: 'AISDLC-9', prUrl: 'https://x/pull/5' },
      ]),
    ).toBe(true);
    expect(prBelongsToTask(board, 'AISDLC-9', 5, 'b', [{ taskId: 'AISDLC-8', prNumber: 5 }])).toBe(
      false,
    );
  });

  it('prBelongsToTask accepts an inflight resume PR number or branch', () => {
    mkdirSync(path.join(board, 'inflight'), { recursive: true });
    writeFileSync(
      path.join(board, 'inflight', 'AISDLC-9.dispatch.json'),
      JSON.stringify({
        taskId: 'AISDLC-9',
        branch: 'ai-sdlc/aisdlc-9-x',
        resume: { prNumber: 12 },
      }),
    );
    expect(prBelongsToTask(board, 'AISDLC-9', 12, 'zzz', [])).toBe(true);
    expect(prBelongsToTask(board, 'AISDLC-9', 13, 'ai-sdlc/aisdlc-9-x', [])).toBe(true);
    expect(prBelongsToTask(board, 'AISDLC-9', 13, 'evil', [])).toBe(false);
  });

  it('allowedAuthors prefers the env list', () => {
    const r = run([]);
    expect([...allowedAuthors(r, '/', { AI_SDLC_RECONCILE_AUTHORS: ' A, b ' })!]).toEqual([
      'a',
      'b',
    ]);
    expect([...allowedAuthors(r, '/', {})!]).toEqual(['me']);
    const bad: CommandRunner = () => ({ status: 1, stdout: '', stderr: '' });
    expect(allowedAuthors(bad, '/', {})).toBeUndefined();
  });
});

describe('rerun is run-id based (AISDLC-945)', () => {
  const ctx: ActionContext = {
    pr: 3,
    taskId: 'AISDLC-1',
    kind: 'task',
    action: 'retrigger-once',
    state: 'pending',
    headSha: 'sha',
    boardDir: '/b',
  };
  const stub = (listOut: string) => {
    const calls: string[][] = [];
    const runner = ((_f: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: args[1] === 'list' ? listOut : '', stderr: '' };
    }) as unknown as Parameters<typeof commandExecutor>[0];
    return { calls, result: commandExecutor(runner, '/cwd', '/bin')(ctx) };
  };

  it('looks up the run id then reruns it', () => {
    const { calls, result } = stub('777\n');
    expect(result).toEqual({ ran: true });
    expect(calls[1]).toEqual(['run', 'rerun', '777', '--failed']);
  });

  it('returns a note, not a failure, when no gate run exists for the head', () => {
    const { calls, result } = stub('');
    expect(result).toEqual({ ran: false, note: 'no gate run for head' });
    expect(calls).toHaveLength(1);
  });
});

describe('rate-limited wait-and-rerun (AISDLC-926)', () => {
  const limited = (over: Partial<ReconcilePr> = {}) =>
    taskPr({
      checks: [
        {
          name: 'ai-sdlc/pr-ready',
          conclusion: 'failure',
          summary: 'API rate limit exceeded for installation',
        },
      ],
      ...over,
    });
  const at = (iso: string) => () => new Date(iso);

  it('waits first: no action, no manifest, summary shows count and reset', () => {
    const execute = vi.fn(() => ({ ran: true }));
    const report = reconcile([limited()], { boardDir: board, execute, now: fixedNow });
    expect(execute).not.toHaveBeenCalled();
    expect(report.records[0]!.state).toBe('rate-limited');
    expect(report.records[0]!.rateLimitResetAt).toBe('2026-10-14T01:00:00.000Z');
    expect(summariseLanding(board)).toContain('rate-limited: 1 (reset 2026-10-14T01:00:00.000Z)');
  });

  it('reruns once per head sha after the reset, never before', () => {
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([limited()], { boardDir: board, execute, now: fixedNow });
    reconcile([limited()], { boardDir: board, execute, now: at('2026-10-14T00:30:00.000Z') });
    expect(execute).not.toHaveBeenCalled();
    reconcile([limited()], { boardDir: board, execute, now: at('2026-10-14T01:05:00.000Z') });
    expect(execute).toHaveBeenCalledTimes(1);
    const ctx = (execute.mock.calls[0] as unknown as [ActionContext])[0];
    expect(ctx.action).toBe('rerun-rate-limited');
    expect(actionCommands(ctx, '/bin')![1]!.args).toEqual(['run', 'rerun', '{runId}', '--failed']);
    reconcile([limited()], { boardDir: board, execute, now: at('2026-10-14T03:00:00.000Z') });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readLanding(board, 10)!.rerunHeadSha).toBe('abc123');
  });

  it('a new head sha gets its own rerun', () => {
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([limited()], { boardDir: board, execute, now: fixedNow });
    reconcile([limited()], { boardDir: board, execute, now: at('2026-10-14T01:05:00.000Z') });
    reconcile([limited({ headSha: 'new999' })], {
      boardDir: board,
      execute,
      now: at('2026-10-14T02:00:00.000Z'),
    });
    reconcile([limited({ headSha: 'new999' })], {
      boardDir: board,
      execute,
      now: at('2026-10-14T03:05:00.000Z'),
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('route-to-planner dedupe (AISDLC-924)', () => {
  const gate = (summary: string) => [
    { name: 'ai-sdlc/pr-ready', conclusion: 'failure' as const, summary },
  ];
  const failing = (over: Partial<ReconcilePr> = {}) =>
    docsPr({ checks: gate('Build and Test failed'), ...over });
  const run = (pr: ReconcilePr) =>
    reconcile([pr], { boardDir: board, execute: () => ({ ran: false }), now: fixedNow });
  const routed = (r: ReturnType<typeof run>) =>
    r.acted.filter((a) => a.action === 'route-to-planner').length;

  it('sends the first report and suppresses repeats of the same key', () => {
    const first = run(failing());
    expect(routed(first)).toBe(1);
    const second = run(failing());
    expect(routed(second)).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(run(failing()).suppressed).toBe(1);
  });

  it('sends again on a new head sha or a new reason', () => {
    expect(routed(run(failing()))).toBe(1);
    expect(routed(run(failing({ headSha: 'new999' })))).toBe(1);
    const r = run(failing({ headSha: 'new999', checks: gate('Lint failed') }));
    expect(routed(r)).toBe(1);
  });

  it('shows the suppressed count in the next summary, once', () => {
    run(failing());
    run(failing());
    run(failing());
    expect(takeSuppressedNote(board)).toBe('planner reports suppressed: 2');
    expect(takeSuppressedNote(board)).toBe('');
  });

  it('persists on the board across a restart', () => {
    run(failing());
    const raw = readFileSync(path.join(board, 'landing', 'planner-routes.json'), 'utf-8');
    expect(JSON.parse(raw).sent).toHaveLength(1);
    // A fresh reconcile call holds no memory: only the file carries the state.
    expect(run(failing()).suppressed).toBe(1);
  });
});

describe('main health (AISDLC-929)', () => {
  const runner =
    (head: string | number, runs: string | number): CommandRunner =>
    (_f, args) => {
      const v = args[0] === 'api' ? head : runs;
      return typeof v === 'number'
        ? { status: v, stdout: '', stderr: 'err' }
        : { status: 0, stdout: v, stderr: '' };
    };
  const red = JSON.stringify([{ conclusion: 'failure', url: 'https://x/runs/1' }]);

  it('reads red, green and unknown', () => {
    expect(gatherMainHealth(runner('abcdef123456\n', red), '/')).toEqual({
      status: 'red',
      sha: 'abcdef123456',
      runUrl: 'https://x/runs/1',
    });
    expect(
      gatherMainHealth(runner('abc', JSON.stringify([{ conclusion: 'success' }])), '/'),
    ).toEqual({ status: 'green', sha: 'abc' });
    expect(gatherMainHealth(runner('abc', '[]'), '/')).toEqual({ status: 'unknown', sha: 'abc' });
    expect(gatherMainHealth(runner('abc', 'nope'), '/').status).toBe('unknown');
    expect(
      gatherMainHealth(runner('abc', JSON.stringify([{ conclusion: 'cancelled' }])), '/').status,
    ).toBe('unknown');
    expect(gatherMainHealth(runner(1, red), '/').status).toBe('unknown');
    expect(gatherMainHealth(runner('', red), '/').status).toBe('unknown');
  });

  it('routes a red sha once and routes nothing for green or unknown', () => {
    const health = { status: 'red' as const, sha: 'abcdef123456', runUrl: 'https://x/runs/1' };
    const opts = { boardDir: board, execute: () => ({ ran: false }), now: fixedNow };
    const first = reconcile([], { ...opts, mainHealth: health });
    expect(first.main).toBe('main: RED at abcdef12 https://x/runs/1');
    expect(first.routed).toEqual({ action: 'route-to-planner', text: first.main });
    const again = reconcile([], { ...opts, mainHealth: health });
    expect(again.main).toBe(first.main);
    expect(again.routed).toBeUndefined();
    const next = reconcile([], { ...opts, mainHealth: { ...health, sha: '999999999999' } });
    expect(next.routed).toBeDefined();
    const green = reconcile([], { ...opts, mainHealth: { status: 'green', sha: 'a' } });
    expect(green).toMatchObject({ main: 'main: green' });
    expect(green.routed).toBeUndefined();
    const unknown = reconcile([], { ...opts, mainHealth: { status: 'unknown' } });
    expect(unknown.main).toBe('main: unknown');
    expect(unknown.routed).toBeUndefined();
    expect(reconcile([], opts).main).toBeUndefined();
  });

  it('red without a run url still routes', () => {
    const r = reconcile([], {
      boardDir: board,
      execute: () => ({ ran: false }),
      mainHealth: { status: 'red', sha: 'abcdef123456' },
    });
    expect(r.main).toBe('main: RED at abcdef12');
  });
});

describe('same-head loop guard (AISDLC-883)', () => {
  const dirty = (sha: string) => taskPr({ mergeStateStatus: 'DIRTY', headSha: sha });
  const quiet = (sha: string) => taskPr({ mergeStateStatus: 'BLOCKED', headSha: sha, checks: [] });

  it('routes a repeat of the same action on the same head to the planner, and resets on a new head', () => {
    const execute = vi.fn((_ctx: ActionContext) => ({ ran: true }));
    const rebases = () => execute.mock.calls.filter(([c]) => c.action === 'land-prep').length;
    const pass = (f: ReconcilePr) => reconcile([f], { boardDir: board, execute, now: fixedNow });

    pass(dirty('H'));
    expect(rebases()).toBe(1);
    // The same facts again are the idempotent no-op, not a repeat.
    pass(dirty('H'));
    expect(rebases()).toBe(1);

    pass(quiet('H'));
    const guarded = pass(dirty('H'));
    expect(guarded.records[0]!.action).toBe('route-to-planner');
    expect(guarded.records[0]!.note).toBe('rebase@H x2');
    expect(guarded.acted[0]!.note).toBe('rebase@H x2');
    expect(rebases()).toBe(1);

    // Stays guarded, and stable, while the head does not move.
    pass(dirty('H'));
    expect(
      readLanding(board, 10)!.history.filter((h) => h.action === 'route-to-planner'),
    ).toHaveLength(1);

    // A push to a new head allows one rebase again.
    const next = pass(dirty('H2'));
    expect(next.records[0]!.action).toBe('land-prep');
    expect(rebases()).toBe(2);
  });

  it('a larger maxSameHeadActions from config allows more same-head actions before parking', () => {
    const execute = vi.fn((_ctx: ActionContext) => ({ ran: true }));
    const rebases = () => execute.mock.calls.filter(([c]) => c.action === 'land-prep').length;
    const pass = (f: ReconcilePr) =>
      reconcile([f], { boardDir: board, execute, now: fixedNow, maxSameHeadActions: 2 });
    pass(dirty('H'));
    pass(quiet('H'));
    expect(pass(dirty('H')).records[0]!.action).toBe('land-prep');
    pass(quiet('H'));
    const parked = pass(dirty('H'));
    expect(parked.records[0]!.action).toBe('route-to-planner');
    expect(parked.records[0]!.note).toBe('rebase@H x3');
    expect(rebases()).toBe(2);
  });
});

describe('superseded close (AISDLC-1011)', () => {
  it('closes a would-be route-to-planner PR once and records it as closed-unlanded', () => {
    const f = docsPr({ checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' }] });
    const execute = vi.fn(() => ({ ran: true }));
    const closeSuperseded = vi.fn(() => 99);
    const r = reconcile([f], { boardDir: board, execute, now: fixedNow, closeSuperseded });
    expect(closeSuperseded).toHaveBeenCalledWith(20);
    expect(r.acted[0]).toMatchObject({ action: 'superseded-close', note: 'superseded by #99' });
    expect(execute).not.toHaveBeenCalled();
    expect(readLanding(board, 20)?.closedUnlanded).toBeDefined();
  });

  it('keeps route-to-planner when the closer declines, and never asks for other actions', () => {
    const failing = docsPr({ checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' }] });
    const closeSuperseded = vi.fn(() => undefined);
    const r = reconcile([failing], {
      boardDir: board,
      execute: () => ({ ran: false }),
      now: fixedNow,
      closeSuperseded,
    });
    expect(r.acted[0]?.action).toBe('route-to-planner');
    const g = docsPr({ prNumber: 21 });
    closeSuperseded.mockClear();
    reconcile([g], {
      boardDir: board,
      execute: () => ({ ran: true }),
      now: fixedNow,
      closeSuperseded,
    });
    expect(closeSuperseded).not.toHaveBeenCalled();
  });
});

describe('open PR aging sweep (AISDLC-1092)', () => {
  const red = () =>
    taskPr({ checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'x' }] });
  const at = (h: number) => () => new Date(Date.parse('2026-10-14T00:00:00.000Z') + h * 3_600_000);

  it('re-runs the action after 7h unchanged, not after 1h', () => {
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([red()], { boardDir: board, execute, now: at(0) });
    reconcile([red()], { boardDir: board, execute, now: at(1) });
    expect(execute).toHaveBeenCalledTimes(1);
    reconcile([red()], { boardDir: board, execute, now: at(7) });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(readLanding(board, 10)?.agedAttempts).toBe(2);
    expect(readLanding(board, 10)?.lastActionAt).toBe(at(7)().toISOString());
  });

  it('routes one line to the planner after three attempts and stops retrying', () => {
    const execute = vi.fn(() => ({ ran: true }));
    for (const h of [0, 7, 14, 21, 28, 35]) {
      reconcile([red()], { boardDir: board, execute, now: at(h) });
    }
    expect(execute).toHaveBeenCalledTimes(3);
    const report = reconcile([red()], { boardDir: board, execute, now: at(42) });
    expect(report.acted).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
