/**
 * Host edge paths of the workflow engine: operator cancel at each step boundary, and the staged
 * review (RFC-0052) branches of the reviewer-result handler, with the staged driver mocked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import {
  DEV_RETURN,
  makeHarness,
  makeTask,
  type Harness,
} from '../__test-helpers/next-step-fixtures.js';
import { readState, type NextStepDeps } from '../next-step/next-step.js';
import type { StagedAdvance } from '../next-step/staged-round.js';
import type { AggregatedVerdict } from '../types.js';
import type {
  DoneInstruction,
  NextStepContext,
  ReviewRoundState,
  SpawnedReviewer,
} from '../next-step/types.js';
import { workflowNextStep } from './execute-host.js';

const advance = vi.hoisted(() => vi.fn());
vi.mock('../next-step/staged-round.js', async (orig) => ({
  ...(await orig<typeof import('../next-step/staged-round.js')>()),
  advanceStagedRound: advance,
}));

let h: Harness;
let ctx: NextStepContext;
let worktree: string;
const DEV_JSON = JSON.stringify(DEV_RETURN);

const spawned: SpawnedReviewer = {
  reviewer: 'code-reviewer',
  agent: 'code-reviewer-codex',
  harness: 'codex',
  leafModel: 'm',
  promptFile: '/files/r.md',
};

function review(round: number, staged = false): ReviewRoundState {
  return {
    round,
    spawned: [spawned],
    autoApproved: [],
    headSha: 'h',
    nonce: 'n',
    harnessNote: '',
    classifier: { reviewers: ['testing'], confidence: 1, fellOpen: false },
    incremental: {
      reason: 'no-marker',
      skip: false,
      deltaOnly: false,
      deltaSize: 0,
      lastReviewedSha: null,
      contentHash: 'c',
    },
    ...(staged
      ? {
          staged: {
            stage: 'plan' as const,
            seal: 's',
            plannerAttempt: 1 as const,
            plannerPromptFile: '/p.md',
            plannerModel: 'm',
            synthModel: 'm',
            security: spawned,
          },
        }
      : {}),
  };
}

const approved: AggregatedVerdict = {
  approved: true,
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  decision: 'APPROVED',
  verdicts: [],
  harnessNote: '',
  summary: '',
};

let prepares: number;
function deps(staged: boolean, over: Partial<NextStepDeps> = {}): Partial<NextStepDeps> {
  return {
    initTask: async () => ({
      ok: true,
      branch: 'b',
      worktreePath: worktree,
      task: makeTask(),
      fromStatus: 'To Do',
      promptFile: '/files/developer-prompt-1.md',
    }),
    prepareReview: async (_c, _s, round, opts) => {
      prepares += 1;
      return {
        kind: 'spawn',
        review: review(round, staged && opts?.noStaged !== true),
        classifierLine: 'c',
      };
    },
    finalizeReview: async () => ({ ok: true, verdict: approved, warnings: [] }),
    leasePreflight: () => ({ status: 'skipped', blocking: false, failing: [], message: '' }),
    preSignRebase: async () => ({ kind: 'skipped', reason: 'up to date' }),
    ship: async (_c, s) =>
      ({
        action: 'done',
        taskId: s.taskId,
        branch: s.branch,
        worktreePath: s.worktreePath,
        outcome: 'approved',
        prUrl: 'https://github.com/o/r/pull/9',
        siblingPrUrls: [],
        iterations: s.iteration,
        developer: s.developer,
        reviews: null,
      }) satisfies DoneInstruction,
    ...over,
  };
}

beforeEach(() => {
  h = makeHarness();
  ctx = h.ctx;
  worktree = join(h.root, '.worktrees', 'aisdlc-900');
  mkdirSync(worktree, { recursive: true });
  h.runner.on(/^git rev-parse --verify/, ok('a'.repeat(40)));
  h.runner.on(/^git show /, fail('none'));
  advance.mockReset();
  prepares = 0;
});
afterEach(() => h.cleanup());

const cancelAt = (): void => {
  const sessions = join(h.root, '.ai-sdlc', 'dispatch', 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'aisdlc-900.cancel.json'), JSON.stringify({ reason: 'enough' }));
};

describe('cancel back-channel (AISDLC-481)', () => {
  it('stops at the first boundary when the signal is already there', async () => {
    cancelAt();
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps(false));
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('cancelled');
  });

  it('stops after the developer returns, before any review is planned', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps(false));
    cancelAt();
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps(false));
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('cancelled');
    expect(prepares).toBe(0);
  });

  it('stops after the reviewers return, before the verdict is acted on', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps(false));
    await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps(false));
    cancelAt();
    const result = JSON.stringify({
      reviewers: [{ agent: 'code-reviewer-codex', approved: true }],
    });
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result }, deps(false));
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('cancelled');
    expect(readState(ctx.statePath)?.phase).toBe('aborted');
  });
});

describe('staged review stages through the engine', () => {
  async function toStagedReply(): Promise<void> {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps(true));
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps(true));
    expect(out.instruction.action).toBe('spawn-reviewers');
  }
  const reply = JSON.stringify({ reviewers: [{ agent: 'review-planner', agentId: 'p1' }] });

  it('asks for a corrected report when the stage output is unusable', async () => {
    await toStagedReply();
    advance.mockResolvedValueOnce({ kind: 'fix', reason: 'name the outputFile' } as StagedAdvance);
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: reply }, deps(true));
    expect(out.instruction).toMatchObject({ action: 'fix-report', reason: 'name the outputFile' });
    expect(readState(ctx.statePath)?.workflow?.records.at(-1)?.status).toBe('spawned');
  });

  it('aborts when the staged run is corrupt', async () => {
    await toStagedReply();
    advance.mockResolvedValueOnce({ kind: 'abort', reason: 'corrupt staged run' } as StagedAdvance);
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: reply }, deps(true));
    expect(out.instruction).toMatchObject({ action: 'stop', reason: 'corrupt staged run' });
  });

  it('spawns the next stage and keeps the review node pending', async () => {
    await toStagedReply();
    advance.mockResolvedValueOnce({ kind: 'spawn', review: review(1, true) } as StagedAdvance);
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: reply }, deps(true));
    expect(out.instruction.action).toBe('spawn-reviewers');
    expect(readState(ctx.statePath)?.phase).toBe('awaiting-reviewers');
  });

  it('falls back to the three-reviewer set by re-planning once without the staged review', async () => {
    await toStagedReply();
    advance.mockResolvedValueOnce({ kind: 'fallback', reason: 'too small' } as StagedAdvance);
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: reply }, deps(true));
    expect(out.instruction.action).toBe('spawn-reviewers');
    expect(prepares).toBe(2);
    expect(readState(ctx.statePath)?.review?.staged).toBeUndefined();
    expect(h.logs.some((l) => l.includes('fell back to the three-reviewer set'))).toBe(true);
  });
});
