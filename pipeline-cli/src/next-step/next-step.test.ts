/**
 * State-machine tests for `next-step` (AISDLC-762 AC-3).
 *
 * The collaborators (init, review-prepare, review-finalize, rebase, ship) are
 * injected so these tests pin the MACHINE: which instruction comes back for
 * which result, what state survives between calls, and how many orchestration
 * calls a run costs (AC-2). The collaborators have their own suites.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEV_RETURN,
  makeHarness,
  makeTask,
  writeDemoTaskFile,
  type Harness,
} from '../__test-helpers/next-step-fixtures.js';
import type { AggregatedVerdict, ReviewerVerdict } from '../types.js';
import { approvedWithoutReviewers } from './review-finalize.js';
import { extractJson, nextStep, readState, writeState, type NextStepDeps } from './next-step.js';
import type {
  DoneInstruction,
  Instruction,
  NextStepContext,
  NextStepState,
  ReviewRoundState,
} from './types.js';

let h: Harness;
let ctx: NextStepContext;
let shipped: NextStepState[];
let worktree: string;

const DEV_JSON = JSON.stringify(DEV_RETURN);
const reviewersJson = (approved = true): string =>
  JSON.stringify({
    reviewers: ['code-reviewer-codex', 'security-reviewer'].map((agent, i) => ({
      agent,
      agentId: `a${i}`,
      approved,
      findings: approved ? [] : [{ severity: 'major', file: 'x.ts', line: 1, message: 'fix me' }],
      summary: 's',
    })),
  });

const verdict = (approved: boolean): AggregatedVerdict => {
  const verdicts: ReviewerVerdict[] = [
    {
      agentId: 'code-reviewer-codex',
      harness: 'codex',
      approved,
      findings: approved ? [] : [{ severity: 'major', file: 'x.ts', line: 1, message: 'fix me' }],
    },
  ];
  return {
    approved,
    counts: { critical: 0, major: approved ? 0 : 1, minor: 0, suggestion: 0 },
    decision: approved ? 'APPROVED' : 'CHANGES_REQUESTED',
    verdicts,
    harnessNote: '',
    summary: '',
  };
};

function reviewRound(round: number): ReviewRoundState {
  return {
    round,
    spawned: [
      {
        reviewer: 'code-reviewer',
        agent: 'code-reviewer-codex',
        harness: 'codex',
        leafModel: 'm',
        promptFile: `/files/review-r${round}-code.md`,
      },
      {
        reviewer: 'security-reviewer',
        agent: 'security-reviewer',
        harness: 'claude-code',
        leafModel: 'm',
        model: 'opus',
        promptFile: `/files/review-r${round}-sec.md`,
      },
    ],
    autoApproved: [],
    headSha: 'h',
    nonce: 'n',
    harnessNote: '',
    classifier: { reviewers: ['testing', 'critic', 'security'], confidence: 1, fellOpen: false },
    incremental: {
      reason: 'no-marker',
      skip: false,
      deltaOnly: false,
      deltaSize: 0,
      lastReviewedSha: null,
      contentHash: 'c',
    },
  };
}

interface Script {
  /** Verdict approval per review round, in order (default: always approved). */
  approvals?: boolean[];
  /** Rebase outcome per approved review, in order (default: skipped). */
  rebases?: Array<'skipped' | 'unchanged' | 'changed' | 'failed'>;
  prepare?: NextStepDeps['prepareReview'];
}

let counters: {
  prepared: number;
  finalized: number;
  rebased: number;
  devPrompts: Array<{ iteration?: number; feedback?: string }>;
};

function deps(script: Script = {}): Partial<NextStepDeps> {
  const approvals = script.approvals ?? [];
  const rebases = script.rebases ?? [];
  return {
    initTask: async () => ({
      ok: true,
      branch: 'ai-sdlc/aisdlc-900-demo-task',
      worktreePath: worktree,
      task: makeTask(),
      fromStatus: 'To Do',
      promptFile: '/files/developer-prompt-1.md',
      model: 'sonnet',
    }),
    prepareReview:
      script.prepare ??
      (async (_c, _s, round) => {
        counters.prepared += 1;
        return {
          kind: 'spawn',
          review: reviewRound(round),
          classifierLine: 'Classifier decision: [x]',
        };
      }),
    finalizeReview: async () => {
      const approved = approvals[counters.finalized] ?? true;
      counters.finalized += 1;
      return { ok: true, verdict: verdict(approved), warnings: [] };
    },
    preSignRebase: async () => {
      const kind = rebases[counters.rebased] ?? 'skipped';
      counters.rebased += 1;
      if (kind === 'failed') return { kind: 'failed', reason: 'rebase-conflict: resolve by hand' };
      if (kind === 'changed') return { kind: 'changed', before: 'A', after: 'B' };
      if (kind === 'unchanged') return { kind: 'unchanged', hash: 'A' };
      return { kind: 'skipped', reason: 'up to date' };
    },
    ship: async (_c, s) => {
      shipped.push(structuredClone(s));
      const done: DoneInstruction = {
        action: 'done',
        taskId: s.taskId,
        branch: s.branch,
        worktreePath: s.worktreePath,
        outcome: s.needsHumanAttention ? 'needs-human-attention' : 'approved',
        prUrl: 'https://github.com/o/r/pull/9',
        siblingPrUrls: [],
        iterations: s.iteration,
        developer: s.developer,
        reviews: null,
      };
      return done;
    },
    buildDeveloperPrompt: async (o) => {
      counters.devPrompts.push({ iteration: o.iteration, feedback: o.reviewerFeedback });
      return { prompt: `iteration ${o.iteration ?? 1} prompt`, task: o.task };
    },
  };
}

/** Act as the model: answer each instruction like a well-behaved session. */
async function drive(
  d: Partial<NextStepDeps>,
  opts: {
    task?: string;
    devResult?: (i: number) => string;
    reviewResult?: (round: number) => string;
  } = {},
): Promise<{ instructions: Instruction[]; last: Instruction; exitCodes: number[] }> {
  const instructions: Instruction[] = [];
  const exitCodes: number[] = [];
  const task = opts.task ?? 'AISDLC-900';
  let out = await nextStep(ctx, { task, ...{} }, d);
  instructions.push(out.instruction);
  exitCodes.push(out.exitCode);
  for (let guard = 0; guard < 30; guard++) {
    const i = out.instruction;
    if (i.action === 'done' || i.action === 'stop') break;
    const result =
      i.action === 'spawn-developer'
        ? (opts.devResult?.(i.iteration) ?? DEV_JSON)
        : (opts.reviewResult?.(i.round) ?? reviewersJson());
    out = await nextStep(ctx, { task, result }, d);
    instructions.push(out.instruction);
    exitCodes.push(out.exitCode);
  }
  return { instructions, last: instructions[instructions.length - 1], exitCodes };
}

beforeEach(() => {
  h = makeHarness();
  ctx = h.ctx;
  worktree = join(h.root, '.worktrees', 'aisdlc-900');
  mkdirSync(worktree, { recursive: true });
  shipped = [];
  counters = { prepared: 0, finalized: 0, rebased: 0, devPrompts: [] };
});
afterEach(() => h.cleanup());

const persisted = (): NextStepState => readState(ctx.statePath)!;

describe('happy path', () => {
  it('is spawn-developer, spawn-reviewers, done: three calls, one exit-0 each', async () => {
    const { instructions, exitCodes } = await drive(deps());
    expect(instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'done',
    ]);
    expect(exitCodes).toEqual([0, 0, 0]);
    const dev = instructions[0];
    if (dev.action !== 'spawn-developer') throw new Error('unreachable');
    expect(dev).toMatchObject({
      agent: 'developer',
      iteration: 1,
      promptFile: '/files/developer-prompt-1.md',
      cwd: worktree,
      model: 'sonnet',
    });
    expect(dev.reply).toContain('next-step --task AISDLC-900');
    expect(dev.reply).toContain(`--state ${ctx.statePath}`);
    expect(dev.reply.endsWith('--result -')).toBe(true);
    expect(dev.reply).toContain('/cli/bin/ai-sdlc-pipeline.mjs');

    const rv = instructions[1];
    if (rv.action !== 'spawn-reviewers') throw new Error('unreachable');
    expect(rv.reviewers).toEqual([
      { agent: 'code-reviewer-codex', promptFile: '/files/review-r1-code.md' },
      { agent: 'security-reviewer', promptFile: '/files/review-r1-sec.md', model: 'opus' },
    ]);
    expect(rv.replyShape).toContain('agentId');

    expect(instructions[2]).toMatchObject({
      action: 'done',
      outcome: 'approved',
      prUrl: 'https://github.com/o/r/pull/9',
    });
    expect(shipped).toHaveLength(1);
    expect(shipped[0].needsHumanAttention).toBe(false);
    expect(shipped[0].developer).toEqual(DEV_RETURN);
    expect(persisted()).toMatchObject({ phase: 'done', calls: 3 });
  });

  it('writes the state file atomically and leaves no tmp file behind', async () => {
    await drive(deps());
    expect(existsSync(`${ctx.statePath}.tmp`)).toBe(false);
    expect(persisted().schemaVersion).toBe(1);
  });

  it('goes straight to ship when the review has nothing to spawn', async () => {
    const { instructions } = await drive(
      deps({
        prepare: async (_c, _s, round) => ({
          kind: 'nothing-to-spawn',
          review: { ...reviewRound(round), spawned: [] },
          classifierLine: 'Classifier decision: []',
          verdicts: [],
        }),
      }),
    );
    expect(instructions.map((i) => i.action)).toEqual(['spawn-developer', 'done']);
    expect(shipped[0].verdict?.decision).toBe('APPROVED');
    expect(shipped[0].classifierLine).toBe('Classifier decision: []');
  });

  it('accepts a developer envelope wrapped in prose and a code fence', async () => {
    const wrapped = `All done!\n\`\`\`json\n${DEV_JSON}\n\`\`\`\nThanks.`;
    const { last } = await drive(deps(), { devResult: () => wrapped });
    expect(last.action).toBe('done');
  });
});

describe('refusals before any state exists', () => {
  it('refuses a CCR sandbox with the supported alternatives and writes no state', async () => {
    ctx = { ...ctx, env: { CLAUDE_CODE_ENV: 'ccr' } };
    const out = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction).toMatchObject({ action: 'stop', outcome: 'aborted', prUrl: null });
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain(
      'mcp__backlog__task_create',
    );
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('lets the CCR override through', async () => {
    ctx = { ...ctx, env: { CLAUDE_CODE_ENV: 'ccr', AI_SDLC_SKIP_CCR_GUARD: '1' } };
    const out = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(out.instruction.action).toBe('spawn-developer');
  });

  it('rejects an argument that matches no accepted form', async () => {
    const out = await nextStep(ctx, { task: 'not a task' }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('Accepted forms');
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('stops with the reason when init refuses (validation, preflight, hooks, ...)', async () => {
    const out = await nextStep(
      ctx,
      { task: 'AISDLC-900' },
      {
        ...deps(),
        initTask: async () => ({ ok: false, reason: 'dependency preflight failed for AISDLC-900' }),
      },
    );
    expect(out).toMatchObject({ exitCode: 1 });
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('preflight');
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('routes a GitHub issue straight to the composite and never creates state', async () => {
    const done: DoneInstruction = {
      action: 'done',
      taskId: 'gh-issue-612',
      branch: 'b',
      worktreePath: 'w',
      outcome: 'approved',
      prUrl: 'https://github.com/o/r/pull/612',
      siblingPrUrls: [],
      iterations: 1,
      developer: null,
      reviews: null,
    };
    h.present.add(join(h.root, 'dogfood', 'dist', 'dispatch-from-issue.js'));
    for (const arg of ['gh:612', '#612', '612']) {
      let asked = 0;
      const out = await nextStep(
        ctx,
        { task: arg },
        {
          ...deps(),
          ghIssue: {
            claudeOnPath: async () => true,
            fetchSpec: async () => ({ spec: makeTask({ id: 'gh-issue-612' }), issueNumber: 612 }),
            execute: async () => {
              asked += 1;
              return {
                taskId: 'gh-issue-612',
                branch: 'b',
                worktreePath: 'w',
                outcome: 'approved',
                prUrl: done.prUrl,
                siblingPrUrls: [],
                iterations: 1,
                finalVerdict: null,
              };
            },
          },
        },
      );
      expect(out.instruction).toMatchObject({ action: 'done', prUrl: done.prUrl });
      expect(asked).toBe(1);
    }
    expect(existsSync(ctx.statePath)).toBe(false);
  });
});

describe('resuming and idempotence', () => {
  it('re-emits the pending developer instruction when called without a result', async () => {
    const first = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    const again = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    const empty = await nextStep(ctx, { task: 'AISDLC-900', result: '  \n' }, deps());
    expect(again.instruction).toEqual(first.instruction);
    expect(empty.instruction).toEqual(first.instruction);
    expect(counters.prepared).toBe(0);
  });

  it('re-emits the pending reviewer instruction without re-running review-prepare', async () => {
    const first = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(first.instruction.action).toBe('spawn-developer');
    const rv = await nextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    const again = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(again.instruction).toEqual(rv.instruction);
    expect(counters.prepared).toBe(1);
  });

  it('replays the stored terminal instruction for a finished run', async () => {
    const { last } = await drive(deps());
    const replay = await nextStep(ctx, { task: 'AISDLC-900', result: 'ignored' }, deps());
    expect(replay.instruction).toEqual(last);
    expect(shipped).toHaveLength(1);
  });

  it('refuses a state file that belongs to another task and leaves it untouched', async () => {
    await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    const before = readFileSync(ctx.statePath, 'utf8');
    const out = await nextStep(ctx, { task: 'AISDLC-901', result: DEV_JSON }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain(
      'belongs to AISDLC-900',
    );
    // The calls counter ticked in memory only; the file on disk is unchanged.
    expect(readFileSync(ctx.statePath, 'utf8')).toBe(before);
  });

  it('matches the task case-insensitively', async () => {
    await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    const out = await nextStep(ctx, { task: 'aisdlc-900', result: DEV_JSON }, deps());
    expect(out.instruction.action).toBe('spawn-reviewers');
  });

  it('rejects an unsupported state schema', () => {
    mkdirSync(dirname(ctx.statePath), { recursive: true });
    writeFileSync(ctx.statePath, JSON.stringify({ schemaVersion: 99 }));
    expect(() => readState(ctx.statePath)).toThrow(/unsupported next-step state schema/);
  });

  it('round-trips state through writeState/readState', () => {
    const s = { schemaVersion: 1, taskId: 'X-1' } as unknown as NextStepState;
    writeState(join(h.root, 'nested', 'dir', 's.json'), s);
    expect(readState(join(h.root, 'nested', 'dir', 's.json'))).toEqual(s);
    expect(readState(join(h.root, 'absent.json'))).toBeNull();
  });
});

describe('developer failures roll back and stop', () => {
  beforeEach(() => {
    writeDemoTaskFile(worktree);
    writeFileSync(join(worktree, '.active-task'), 'AISDLC-900\n');
  });

  it('reverts the task status, keeps the worktree, drops the sentinel and never reviews', async () => {
    const failed = JSON.stringify({ ...DEV_RETURN, commitSha: null, notes: 'could not do it' });
    const { last, exitCodes } = await drive(deps(), { devResult: () => failed });
    expect(last).toMatchObject({ action: 'stop', outcome: 'developer-failed', prUrl: null });
    expect(exitCodes.at(-1)).toBe(1);
    expect(last.action === 'stop' && last.reason).toMatch(
      /null commitSha[\s\S]*Worktree preserved at .*aisdlc-900/,
    );
    expect(last.action === 'stop' && last.reason).toContain('/ai-sdlc cleanup AISDLC-900');
    expect(
      readFileSync(join(worktree, 'backlog', 'tasks', 'aisdlc-900 - demo-task.md'), 'utf8'),
    ).toContain('status: To Do');
    expect(existsSync(join(worktree, '.active-task'))).toBe(false);
    expect(existsSync(worktree)).toBe(true);
    expect(counters.prepared).toBe(0);
    expect(persisted().phase).toBe('aborted');
  });

  it('treats a failed verification as a developer failure', async () => {
    const bad = JSON.stringify({
      ...DEV_RETURN,
      verifications: { ...DEV_RETURN.verifications, test: 'failed' },
    });
    const { last } = await drive(deps(), { devResult: () => bad });
    expect(last).toMatchObject({ action: 'stop', outcome: 'developer-failed' });
  });

  it('flags non-JSON prose as a contract violation', async () => {
    const { last } = await drive(deps(), { devResult: () => 'I finished the task, all green!' });
    expect(last).toMatchObject({ action: 'stop', outcome: 'developer-json-contract-violated' });
  });
});

describe('iteration (Step 9) and the human-attention cap', () => {
  it('sends reviewer findings back to the developer, then ships once approved', async () => {
    const { instructions, last } = await drive(deps({ approvals: [false, true] }));
    expect(instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'spawn-developer',
      'spawn-reviewers',
      'done',
    ]);
    const second = instructions[2];
    expect(second.action === 'spawn-developer' && second.iteration).toBe(2);
    expect(second.action === 'spawn-developer' && second.promptFile).toMatch(
      /developer-prompt-2\.md$/,
    );
    expect(readFileSync(join(ctx.filesDir, 'developer-prompt-2.md'), 'utf8')).toBe(
      'iteration 2 prompt',
    );
    expect(counters.devPrompts[0].iteration).toBe(2);
    expect(counters.devPrompts[0].feedback).toContain('fix me');
    expect(last).toMatchObject({ action: 'done', outcome: 'approved', iterations: 2 });
    expect(counters.rebased).toBe(1);
  });

  it('opens the PR for a human after two failed passes instead of aborting', async () => {
    const { instructions, last } = await drive(deps({ approvals: [false, false] }));
    expect(instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'spawn-developer',
      'spawn-reviewers',
      'done',
    ]);
    expect(last).toMatchObject({ action: 'done', outcome: 'needs-human-attention', iterations: 2 });
    expect(shipped[0].needsHumanAttention).toBe(true);
    // The cap path skips the pre-sign rebase (the human handles it).
    expect(counters.rebased).toBe(0);
  });

  it('respects maxIterations from state', async () => {
    await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    const s = persisted();
    writeState(ctx.statePath, { ...s, maxIterations: 1 });
    await nextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps({ approvals: [false] }));
    const out = await nextStep(
      ctx,
      { task: 'AISDLC-900', result: reviewersJson(false) },
      deps({ approvals: [false] }),
    );
    expect(out.instruction).toMatchObject({ action: 'done', outcome: 'needs-human-attention' });
  });
});

describe('pre-sign rebase (Step 10.5)', () => {
  it('re-reviews exactly once when the rebase changed the content', async () => {
    const { instructions, last } = await drive(deps({ rebases: ['changed', 'changed'] }));
    expect(instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'spawn-reviewers',
      'done',
    ]);
    const round2 = instructions[2];
    expect(round2.action === 'spawn-reviewers' && round2.round).toBe(2);
    expect(last.action).toBe('done');
    // The second approval does not rebase again: no loop.
    expect(counters.rebased).toBe(1);
    expect(counters.prepared).toBe(2);
  });

  it('reuses the approval when the content is unchanged', async () => {
    const { instructions } = await drive(deps({ rebases: ['unchanged'] }));
    expect(instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'done',
    ]);
  });

  it('stops without shipping on a rebase conflict (never auto-resolved)', async () => {
    const { last, exitCodes } = await drive(deps({ rebases: ['failed'] }));
    expect(last).toMatchObject({ action: 'stop', outcome: 'aborted' });
    expect(last.action === 'stop' && last.reason).toContain('rebase-conflict');
    expect(exitCodes.at(-1)).toBe(1);
    expect(shipped).toHaveLength(0);
  });

  it('a re-review that requests changes falls into the normal iteration', async () => {
    const { instructions, last } = await drive(
      deps({ approvals: [true, false, true], rebases: ['changed', 'skipped'] }),
    );
    expect(instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'spawn-reviewers',
      'spawn-developer',
      'spawn-reviewers',
      'done',
    ]);
    expect(last).toMatchObject({ action: 'done', iterations: 2 });
  });
});

describe('a fixable reviewer report asks for a corrected report instead of failing (fix-report)', () => {
  async function toReviewers(d: Partial<NextStepDeps>): Promise<void> {
    await nextStep(ctx, { task: 'AISDLC-900' }, d);
    const rv = await nextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, d);
    expect(rv.instruction.action).toBe('spawn-reviewers');
  }

  it('asks again when the report is not JSON, without respawning or advancing', async () => {
    const d = deps();
    await toReviewers(d);
    const out = await nextStep(ctx, { task: 'AISDLC-900', result: 'looks good to me' }, d);
    expect(out.exitCode).toBe(0);
    expect(out.instruction).toMatchObject({ action: 'fix-report', round: 1 });
    expect(out.instruction.action === 'fix-report' && out.instruction.reason).toContain(
      'not valid JSON',
    );
    expect(out.instruction.action === 'fix-report' && out.instruction.replyShape).toContain(
      'agentId',
    );
    expect(counters.finalized).toBe(0);
    expect(counters.prepared).toBe(1);
    expect(persisted()).toMatchObject({ phase: 'awaiting-reviewers', reportRetries: 1 });
    // A corrected report completes the run and clears the retry counter.
    const ok = await nextStep(ctx, { task: 'AISDLC-900', result: reviewersJson() }, d);
    expect(ok.instruction.action).toBe('done');
    expect(persisted().reportRetries).toBeUndefined();
  });

  it('asks again when finalize reports a recoverable slip (e.g. a missing agent id)', async () => {
    let calls = 0;
    const d = {
      ...deps(),
      finalizeReview: async () =>
        calls++ === 0
          ? {
              ok: false as const,
              recoverable: true,
              reason: 'no harness agent id for security-reviewer',
            }
          : { ok: true as const, verdict: verdict(true), warnings: [] },
    };
    await toReviewers(d);
    const first = await nextStep(ctx, { task: 'AISDLC-900', result: reviewersJson() }, d);
    expect(first.instruction).toMatchObject({
      action: 'fix-report',
      reason: expect.stringContaining('agent id'),
    });
    const second = await nextStep(ctx, { task: 'AISDLC-900', result: reviewersJson() }, d);
    expect(second.instruction.action).toBe('done');
  });

  it('re-emits the fix-report when called without a result', async () => {
    const d = deps();
    await toReviewers(d);
    const first = await nextStep(ctx, { task: 'AISDLC-900', result: 'oops' }, d);
    const again = await nextStep(ctx, { task: 'AISDLC-900' }, d);
    expect(again.instruction).toEqual(first.instruction);
  });

  it('gives up after two corrected reports', async () => {
    const d = deps();
    await toReviewers(d);
    expect(
      (await nextStep(ctx, { task: 'AISDLC-900', result: 'bad 1' }, d)).instruction.action,
    ).toBe('fix-report');
    expect(
      (await nextStep(ctx, { task: 'AISDLC-900', result: 'bad 2' }, d)).instruction.action,
    ).toBe('fix-report');
    const third = await nextStep(ctx, { task: 'AISDLC-900', result: 'bad 3' }, d);
    expect(third).toMatchObject({ exitCode: 1 });
    expect(third.instruction.action === 'stop' && third.instruction.reason).toContain(
      'after 2 corrected reports',
    );
    expect(persisted().phase).toBe('aborted');
  });

  it('a non-recoverable finalize failure still stops the run', async () => {
    const d = {
      ...deps(),
      finalizeReview: async () => ({ ok: false as const, reason: 'persist failed' }),
    };
    await toReviewers(d);
    const out = await nextStep(ctx, { task: 'AISDLC-900', result: reviewersJson() }, d);
    expect(out.instruction).toMatchObject({ action: 'stop', reason: 'persist failed' });
  });
});

describe('failures in the collaborators stop the run', () => {
  it('stops when review-prepare aborts', async () => {
    const { last } = await drive(
      deps({ prepare: async () => ({ kind: 'abort', reason: 'review diff unavailable' }) }),
    );
    expect(last).toMatchObject({
      action: 'stop',
      outcome: 'aborted',
      reason: 'review diff unavailable',
    });
  });

  it.each(['prepareReview', 'finalizeReview'] as const)(
    'a throw from %s still drops the sentinel, reverts status and stops',
    async (which) => {
      const d = {
        ...deps(),
        [which]: async () => {
          throw new Error('boom from ' + which);
        },
      } as NextStepDeps;
      const first = await nextStep(ctx, { task: 'AISDLC-900' }, d);
      expect(first.instruction.action).toBe('spawn-developer');
      let last: Awaited<ReturnType<typeof nextStep>>;
      if (which === 'finalizeReview') {
        const rev = await nextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, d);
        expect(rev.instruction.action).toBe('spawn-reviewers');
        last = await nextStep(ctx, { task: 'AISDLC-900', result: reviewersJson() }, d);
      } else {
        last = await nextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, d);
      }
      expect(last.exitCode).toBe(1);
      expect(last.instruction).toMatchObject({ action: 'stop', reason: `boom from ${which}` });
      expect(existsSync(join(worktree, '.active-task'))).toBe(false);
      expect(persisted().phase).toBe('aborted');
    },
  );

  it('stops when review-finalize fails (e.g. no agent id)', async () => {
    const d = {
      ...deps(),
      finalizeReview: async () => ({ ok: false as const, reason: 'no harness agent id' }),
    };
    const { last } = await drive(d);
    expect(last).toMatchObject({ action: 'stop', reason: 'no harness agent id' });
  });

  it('stops when ship stops (push refused, PR creation failed, ...)', async () => {
    const d = {
      ...deps(),
      ship: async (_c: NextStepContext, s: NextStepState) => ({
        action: 'stop' as const,
        taskId: s.taskId,
        outcome: 'aborted' as const,
        reason: 'non-fast-forward push',
        prUrl: null,
      }),
    };
    const { last, exitCodes } = await drive(d);
    expect(last).toMatchObject({ action: 'stop', reason: 'non-fast-forward push' });
    expect(exitCodes.at(-1)).toBe(1);
    expect(persisted().phase).toBe('aborted');
  });

  it('honours the cancel back-channel at a step boundary (AISDLC-481)', async () => {
    const sessions = join(h.root, '.ai-sdlc', 'dispatch', 'sessions');
    mkdirSync(sessions, { recursive: true });
    await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    writeFileSync(join(sessions, 'aisdlc-900.cancel.json'), JSON.stringify({ reason: 'enough' }));
    const out = await nextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('cancelled');
    expect(counters.prepared).toBe(0);
  });

  it('honours a cancel signal that is already there at the first boundary', async () => {
    const sessions = join(h.root, '.ai-sdlc', 'dispatch', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'aisdlc-900.cancel.json'), '{}');
    const out = await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(out.instruction).toMatchObject({ action: 'stop' });
  });
});

describe('orchestration budget (AC-2: at most 15 calls plus the agents)', () => {
  it('a normal run costs 3 next-step calls', async () => {
    await drive(deps());
    expect(persisted().calls).toBe(3);
  });

  it('the worst case (two developer passes, post-rebase re-review on each) stays under 15', async () => {
    const { instructions } = await drive(
      deps({ approvals: [true, false, true, true], rebases: ['changed', 'changed', 'changed'] }),
    );
    expect(instructions.at(-1)?.action).toBe('done');
    const calls = persisted().calls;
    // start, dev, review, post-rebase re-review (asks for changes), dev pass 2, review,
    // post-rebase re-review: bounded by 2 developer passes x (1 review + 1 re-review).
    expect(calls).toBe(7);
    expect(calls).toBeLessThanOrEqual(15);
  });
});

describe('extractJson', () => {
  it('returns valid JSON untouched', () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('pulls the outermost object or array out of prose', () => {
    expect(extractJson('here: {"a":{"b":2}} bye')).toBe('{"a":{"b":2}}');
    expect(extractJson('see [1,2] ok')).toBe('[1,2]');
  });

  it('returns text with no JSON unchanged so the caller can report it', () => {
    expect(extractJson('no json here')).toBe('no json here');
    expect(extractJson('{ unterminated')).toBe('{ unterminated');
  });
});

describe('approved-without-reviewers verdict', () => {
  it('is APPROVED with zero findings', () => {
    expect(approvedWithoutReviewers('').decision).toBe('APPROVED');
  });
});
