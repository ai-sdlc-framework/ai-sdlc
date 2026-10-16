import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeVerdict } from '../dispatch/board.js';
import { PR_STATES, type PrState } from './pr-state.js';
import {
  actionCommands,
  commandExecutor,
  decide,
  detectKind,
  DOCS_ACTIONS,
  allowedAuthors,
  gatherFacts,
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
    'stale-claim': taskPr({ claimHeartbeatAgeMs: 99 * 60_000 }),
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
    // `reenter` reads the head and the failing line from the PR itself.
    expect(args).toContain('reenter');
    expect(args).not.toContain('resume');
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
    for (const a of ['land-prep', 'push-only-resign', 'reenter']) {
      expect(run(a)![0]!.args.slice(1, 3)).toEqual(['reenter', '3']);
    }
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
    expect(facts).toEqual([]);
  });

  it('acts on a task PR only when its number matches the task record', () => {
    expect(gatherFacts(run([pr({})]), '/', board)).toEqual([]);
    done(5);
    expect(gatherFacts(run([pr({})]), '/', board)!.map((f) => f.prNumber)).toEqual([5]);
    expect(gatherFacts(run([pr({ number: 8 })]), '/', board)).toEqual([]);
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
    expect(actionCommands(ctx, '/bin')![0]!.args).toEqual([
      'run',
      'rerun',
      '--failed',
      '--commit',
      'abc123',
    ]);
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
