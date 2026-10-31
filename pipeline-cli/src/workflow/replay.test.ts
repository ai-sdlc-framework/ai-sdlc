/**
 * Golden replay (RFC-0056 phase 3): the workflow engine and the Machine are driven over the
 * same recorded fixtures with the same collaborators, and must emit the same instruction
 * sequence. This gates the Machine escape hatch (`AI_SDLC_WORKFLOW_ENGINE=0`); it runs in `pnpm test`.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ok, fail } from '../__test-helpers/fake-runner.js';
import {
  DEV_RETURN,
  makeHarness,
  makeTask,
  type Harness,
} from '../__test-helpers/next-step-fixtures.js';
import { nextStep, type NextStepDeps } from '../next-step/next-step.js';
import type { AggregatedVerdict, ReviewerVerdict } from '../types.js';
import type {
  DoneInstruction,
  Instruction,
  NextStepContext,
  NextStepState,
  ReviewRoundState,
} from '../next-step/types.js';
import { defaultGhIssueDeps } from '../next-step/gh-issue.js';
import { workflowNextStep } from './execute-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'test', 'fixtures', 'workflow', 'replay');

interface Fixture {
  name: string;
  approvals?: boolean[];
  rebases?: Array<'skipped' | 'unchanged' | 'changed' | 'failed'>;
  nothingToSpawn?: boolean;
  devResult?: 'failed' | 'parked' | 'prose';
  reviewResult?: 'both' | 'missing-security';
  reviewResults?: string[];
  lease?: 'blocking' | 'warning';
  initRefused?: boolean;
  /** `prepareReview` aborts the run. */
  prepareAbort?: boolean;
  /** `finalizeReview` fails with a non-recoverable reason. */
  finalizeFatal?: boolean;
  /** `ship` throws after the task began (rollback path). */
  shipThrows?: boolean;
  /** Operator cancel signal present before this call is answered. */
  cancelAt?: 'start' | 'developer' | 'reviewers';
  /** The argument handed to every call (default `AISDLC-900`). */
  task?: string;
  /** The Claude Code remote-sandbox guard fires. */
  ccr?: boolean;
  /** Before each answer, call once with no result (idempotent re-emit of the pending instruction). */
  recall?: boolean;
  /** After the first instruction, call with a different task id against the same state file. */
  wrongTask?: boolean;
  /** After a terminal instruction, call again (the persisted result is re-emitted). */
  recallAfterTerminal?: boolean;
  /** The task is resumed: `developer-round` (ordered round) or `full` (no usable attestation). */
  resume?: 'developer-round' | 'full';
}

const fixtures: Fixture[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture);

const BASE_SHA = 'a'.repeat(40);
const DEV_JSON = JSON.stringify(DEV_RETURN);

const reviewersJson = (agents: string[], approved = true): string =>
  JSON.stringify({
    reviewers: agents.map((agent, i) => ({
      agent,
      agentId: `a${i}`,
      approved,
      findings: [],
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

interface Counters {
  prepared: number;
  finalized: number;
  rebased: number;
  devPrompts: Array<{ iteration?: number; feedback?: string }>;
  finalizedWith: string[][];
  shipped: NextStepState[];
}

let h: Harness;
let ctx: NextStepContext;
let worktree: string;
let counters: Counters;

function depsFor(fx: Fixture): Partial<NextStepDeps> {
  const approvals = fx.approvals ?? [];
  const rebases = fx.rebases ?? [];
  return {
    initTask: async () =>
      fx.initRefused
        ? { ok: false, reason: 'dependency preflight failed for AISDLC-900' }
        : {
            ok: true,
            ...(fx.resume ? { resumed: true } : {}),
            ...(fx.resume === 'developer-round' ? { developerRound: true } : {}),
            branch: 'ai-sdlc/aisdlc-900-demo-task',
            worktreePath: worktree,
            task: makeTask(),
            fromStatus: 'To Do',
            promptFile: '/files/developer-prompt-1.md',
            model: 'sonnet',
          },
    prepareReview: async (_c, _s, round) => {
      counters.prepared += 1;
      if (fx.prepareAbort) return { kind: 'abort', reason: 'no diff against the target branch' };
      if (fx.nothingToSpawn) {
        return {
          kind: 'nothing-to-spawn',
          review: { ...reviewRound(round), spawned: [] },
          classifierLine: 'Classifier decision: []',
          verdicts: [],
        };
      }
      return {
        kind: 'spawn',
        review: reviewRound(round),
        classifierLine: 'Classifier decision: [x]',
      };
    },
    // The join rule lives in the collaborator both paths share: every spawned reviewer must report.
    finalizeReview: async (_c, s, reports) => {
      counters.finalizedWith.push(reports.map((r) => r.agent));
      const missing = (s.review?.spawned ?? []).filter(
        (sp) => !reports.some((r) => r.agent === sp.agent),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          recoverable: true,
          reason: `no report for ${missing.map((m) => m.agent).join(', ')}`,
        };
      }
      if (fx.finalizeFatal) {
        return { ok: false, recoverable: false, reason: 'attestation envelope refused' };
      }
      const approved = approvals[counters.finalized] ?? true;
      counters.finalized += 1;
      return { ok: true, verdict: verdict(approved), warnings: [] };
    },
    leasePreflight: () =>
      fx.lease === 'blocking'
        ? { status: 'refused', blocking: true, failing: [], message: 'lease refused' }
        : fx.lease === 'warning'
          ? { status: 'refused', blocking: false, failing: [], message: 'lease warning' }
          : { status: 'skipped', blocking: false, failing: [], message: '' },
    preSignRebase: async () => {
      const kind = rebases[counters.rebased] ?? 'skipped';
      counters.rebased += 1;
      if (kind === 'failed') return { kind: 'failed', reason: 'rebase-conflict: resolve by hand' };
      if (kind === 'changed') return { kind: 'changed', before: 'A', after: 'B' };
      if (kind === 'unchanged') return { kind: 'unchanged', hash: 'A' };
      return { kind: 'skipped', reason: 'up to date' };
    },
    ship: async (_c, s) => {
      counters.shipped.push(structuredClone(s));
      if (fx.shipThrows) throw new Error('gh pr create exploded');
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
    ghIssue: {
      ...defaultGhIssueDeps,
      claudeOnPath: async () => false,
    },
  };
}

function devResultFor(fx: Fixture): string {
  if (fx.devResult === 'failed')
    return JSON.stringify({ ...DEV_RETURN, commitSha: null, notes: 'x' });
  if (fx.devResult === 'parked') {
    return JSON.stringify({
      ...DEV_RETURN,
      commitSha: null,
      notes: { parked: true, done: 'half', remaining: 'rest', why: 'turn budget' },
    });
  }
  if (fx.devResult === 'prose') return 'I finished the task, all green!';
  return DEV_JSON;
}

type Step = typeof nextStep;

function writeCancel(): void {
  const dir = join(ctx.workDir, '.ai-sdlc', 'dispatch', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'aisdlc-900.cancel.json'),
    JSON.stringify({ reason: 'operator-cancel' }),
    'utf8',
  );
}

/** Act as the model: answer each instruction like the recorded session did. */
async function drive(
  run: Step,
  fx: Fixture,
): Promise<{ instructions: Instruction[]; exitCodes: number[] }> {
  const d = depsFor(fx);
  const task = fx.task ?? 'AISDLC-900';
  const instructions: Instruction[] = [];
  const exitCodes: number[] = [];
  const record = (out: { instruction: Instruction; exitCode: number }): void => {
    instructions.push(out.instruction);
    exitCodes.push(out.exitCode);
  };
  let reviewCalls = 0;
  if (fx.ccr) ctx.env.CLAUDE_REMOTE_EXECUTION = '1';
  else delete ctx.env.CLAUDE_REMOTE_EXECUTION;
  if (fx.cancelAt === 'start') writeCancel();
  let out = await run(ctx, { task }, d);
  record(out);
  if (fx.wrongTask) record(await run(ctx, { task: 'AISDLC-901', result: DEV_JSON }, d));
  for (let guard = 0; guard < 30; guard++) {
    const i = out.instruction;
    if (i.action === 'done' || i.action === 'stop') break;
    if (fx.recall) record(await run(ctx, { task }, d));
    let result: string;
    if (i.action === 'spawn-developer') {
      if (fx.cancelAt === 'developer') writeCancel();
      result = devResultFor(fx);
    } else {
      if (fx.cancelAt === 'reviewers') writeCancel();
      const scripted = fx.reviewResults?.[reviewCalls];
      reviewCalls += 1;
      result =
        scripted !== undefined && scripted !== 'both'
          ? scripted
          : fx.reviewResult === 'missing-security'
            ? reviewersJson(['code-reviewer-codex'])
            : reviewersJson(['code-reviewer-codex', 'security-reviewer']);
    }
    out = await run(ctx, { task, result }, d);
    record(out);
  }
  if (fx.recallAfterTerminal) record(await run(ctx, { task, result: DEV_JSON }, d));
  return { instructions, exitCodes };
}

beforeEach(() => {
  h = makeHarness();
  ctx = h.ctx;
  worktree = join(h.root, '.worktrees', 'aisdlc-900');
  mkdirSync(worktree, { recursive: true });
  h.runner.on(/^git rev-parse --verify origin\/main/, ok(BASE_SHA));
  h.runner.on(/^git show /, fail('fatal: path does not exist'));
  counters = {
    prepared: 0,
    finalized: 0,
    rebased: 0,
    devPrompts: [],
    finalizedWith: [],
    shipped: [],
  };
});
afterEach(() => h.cleanup());

/** Operator-visible log lines: resume decisions and warnings/errors must match too. */
const operatorLogs = (): string[] =>
  h.logs.filter((l) => l.includes('[resume]') || l.startsWith('warn:') || l.startsWith('error:'));

function reset(): void {
  h.logs.length = 0;
  rmSync(ctx.statePath, { force: true });
  rmSync(ctx.filesDir, { recursive: true, force: true });
  counters = {
    prepared: 0,
    finalized: 0,
    rebased: 0,
    devPrompts: [],
    finalizedWith: [],
    shipped: [],
  };
}

describe('golden replay: engine vs Machine', () => {
  it('has the recorded fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(29);
    expect(fixtures.map((f) => f.name)).toContain('changes-requested-at-cap');
    expect(fixtures.map((f) => f.name)).toContain('reviewer-return-missing');
  });

  for (const fx of fixtures) {
    it(`${fx.name}: identical instruction sequence, exit codes and collaborator calls`, async () => {
      const machine = await drive(nextStep, fx);
      const machineCounters = structuredClone({ ...counters, shipped: counters.shipped.length });
      const machineShipped = counters.shipped.map((s) => ({
        iteration: s.iteration,
        needsHumanAttention: s.needsHumanAttention,
        reviewRound: s.reviewRound,
        postRebaseReviewed: s.postRebaseReviewed,
      }));
      const machineLogs = operatorLogs();
      reset();
      const engine = await drive(workflowNextStep, fx);
      expect(operatorLogs()).toEqual(machineLogs);
      expect(engine.instructions).toEqual(machine.instructions);
      expect(engine.exitCodes).toEqual(machine.exitCodes);
      expect(structuredClone({ ...counters, shipped: counters.shipped.length })).toEqual(
        machineCounters,
      );
      expect(
        counters.shipped.map((s) => ({
          iteration: s.iteration,
          needsHumanAttention: s.needsHumanAttention,
          reviewRound: s.reviewRound,
          postRebaseReviewed: s.postRebaseReviewed,
        })),
      ).toEqual(machineShipped);
    });
  }

  it('the cap fixture really ends flagged for a human, and the missing-return fixture stops', async () => {
    const cap = fixtures.find((f) => f.name === 'changes-requested-at-cap') as Fixture;
    const capRun = await drive(workflowNextStep, cap);
    expect(capRun.instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'spawn-developer',
      'spawn-reviewers',
      'done',
    ]);
    expect(capRun.instructions.at(-1)).toMatchObject({ outcome: 'needs-human-attention' });
    reset();
    const missing = fixtures.find((f) => f.name === 'reviewer-return-missing') as Fixture;
    const missingRun = await drive(workflowNextStep, missing);
    expect(missingRun.instructions.map((i) => i.action)).toEqual([
      'spawn-developer',
      'spawn-reviewers',
      'fix-report',
      'fix-report',
      'stop',
    ]);
    expect(counters.shipped).toHaveLength(0);
  });

  it('the behaviour fixtures really exercise their path (not a vacuous pair of identical runs)', async () => {
    const expectations: Record<string, { last: Record<string, unknown>; logs?: string }> = {
      'lease-refused-warning': {
        last: { action: 'done', outcome: 'approved' },
        logs: 'lease warning',
      },
      'prepare-abort': { last: { action: 'stop', outcome: 'aborted' } },
      'finalize-fatal': { last: { action: 'stop', outcome: 'aborted' } },
      'ship-throws': { last: { action: 'stop', outcome: 'aborted' } },
      'cancel-at-start': { last: { action: 'stop', outcome: 'aborted' } },
      'cancel-after-developer': { last: { action: 'stop', outcome: 'aborted' } },
      'cancel-after-reviewers': { last: { action: 'stop', outcome: 'aborted' } },
      'bad-argument': { last: { action: 'stop', outcome: 'aborted' } },
      'ccr-refused': { last: { action: 'stop', outcome: 'aborted' } },
      'gh-issue-no-claude': { last: { action: 'stop', outcome: 'aborted' } },
      'recall-after-terminal': { last: { action: 'done', outcome: 'approved' } },
      'resume-developer-round': {
        last: { action: 'done', outcome: 'approved' },
        logs: 'developer-round: ordered by reenter',
      },
      'resume-full': { last: { action: 'done', outcome: 'approved' }, logs: 'review-full' },
    };
    for (const [name, want] of Object.entries(expectations)) {
      const fx = fixtures.find((f) => f.name === name) as Fixture;
      reset();
      const run = await drive(workflowNextStep, fx);
      expect(run.instructions.at(-1), name).toMatchObject(want.last);
      if (want.logs) expect(operatorLogs().join('\n'), name).toContain(want.logs);
    }
    reset();
    const wrong = await drive(
      workflowNextStep,
      fixtures.find((f) => f.name === 'wrong-task-state') as Fixture,
    );
    expect(wrong.instructions[1]).toMatchObject({ action: 'stop' });
    expect((wrong.instructions[1] as { reason: string }).reason).toContain('belongs to');
  });
});
