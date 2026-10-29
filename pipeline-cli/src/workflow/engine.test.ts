import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import {
  DEV_RETURN,
  makeHarness,
  makeTask,
  type Harness,
} from '../__test-helpers/next-step-fixtures.js';
import { nextStep, readState, type NextStepDeps } from '../next-step/next-step.js';
import type { AggregatedVerdict } from '../types.js';
import type { DoneInstruction, NextStepContext, ReviewRoundState } from '../next-step/types.js';
import { WORKFLOW_PATH, workflowDigestFromStateFile } from './digest.js';
import {
  EXECUTE_IMPLS,
  readLedger,
  warnMachineDeprecated,
  workflowEngineEnabled,
  workflowNextStep,
} from './execute-host.js';
import {
  loadWorkflowFromBase,
  prepareWorkflow,
  sampleDivisor,
  topologicalOrder,
  WorkflowRefusal,
} from './engine.js';
import { buildExecuteGraph, renderYaml } from './graph.js';

type Doc = ReturnType<typeof buildExecuteGraph>;
const BASE_SHA = 'b'.repeat(40);
const defaultText = renderYaml(buildExecuteGraph());

function prepare(
  doc: unknown,
  origin: Parameters<typeof prepareWorkflow>[1]['origin'] = {
    kind: 'base',
    baseSha: BASE_SHA,
    path: WORKFLOW_PATH,
  },
) {
  return prepareWorkflow(doc, {
    origin,
    knownImpls: EXECUTE_IMPLS,
    text: '',
    path: WORKFLOW_PATH,
    sha256: 'x',
  });
}

const fresh = (): Doc => load(defaultText) as Doc;

function refusal(fn: () => unknown): WorkflowRefusal {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkflowRefusal);
    return e as WorkflowRefusal;
  }
  throw new Error('expected a WorkflowRefusal');
}

describe('prepareWorkflow refusals (AC-2)', () => {
  it('accepts the default document and orders it topologically', () => {
    const wf = prepare(fresh());
    expect(wf.order[0]).toBe('upkeep');
    expect(wf.order.indexOf('review')).toBeLessThan(wf.order.indexOf('aggregate'));
    expect(wf.loopBodies.get('develop')?.has('iterate')).toBe(true);
    expect(wf.loopBodies.get('upkeep')?.size).toBe(0);
  });

  it('refuses a document that was not loaded from the base branch', () => {
    const r = refusal(() => prepare(fresh(), { kind: 'worktree', path: WORKFLOW_PATH }));
    expect(r.rule).toBe('not-from-base');
    expect(r.message).toContain('base branch only');
  });

  it('refuses an agent declared as an anchor', () => {
    const doc = fresh();
    doc.spec.nodes.aggregate = { kind: 'anchor', impl: 'developer' } as never;
    const r = refusal(() => prepare(doc));
    expect(r.rule).toBe('invalid-document');
  });

  it('refuses an anchor whose impl names an agent role used by the document', () => {
    const doc = fresh();
    doc.spec.nodes.guard = { kind: 'anchor', impl: 'planner' } as never;
    doc.spec.nodes.extra = { kind: 'agent', role: 'planner' } as never;
    doc.spec.edges.push({ from: 'plan', to: 'guard' }, { from: 'plan', to: 'extra' });
    expect(refusal(() => prepare(doc)).message).toContain("impl 'planner' is an agent role");
  });

  it('refuses a path to ship that crosses no anchor', () => {
    const doc = fresh();
    doc.spec.anchors = [];
    const r = refusal(() => prepare(doc));
    expect(r.rule).toBe('ship-without-anchor');
  });

  it('refuses a document with no ship node', () => {
    const doc = fresh();
    delete doc.spec.nodes.ship;
    doc.spec.edges = doc.spec.edges.filter((e) => e.from !== 'ship' && e.to !== 'ship');
    expect(refusal(() => prepare(doc)).rule).toBe('no-ship-node');
  });

  it('refuses an undeclared cycle', () => {
    const doc = fresh();
    doc.spec.edges.push({ from: 'cleanup', to: 'upkeep' });
    const r = refusal(() => prepare(doc));
    expect(r.rule).toBe('undeclared-cycle');
  });

  it('refuses an impl the host has no implementation for', () => {
    const doc = fresh();
    doc.spec.nodes.upkeep = { kind: 'step', impl: 'does-not-exist' } as never;
    expect(refusal(() => prepare(doc)).rule).toBe('unknown-impl');
  });

  it('refuses a fan-out whose join is not expect: all', () => {
    const doc = fresh();
    (doc.spec.nodes.review as { expect: string }).expect = 'quorum(2)';
    expect(refusal(() => prepare(doc)).rule).toBe('unsupported-expect');
  });

  it('refuses a schema-invalid document', () => {
    expect(refusal(() => prepare({ kind: 'Workflow' })).rule).toBe('invalid-document');
  });
});

describe('Kahn sort', () => {
  it('orders a DAG and comes up short on a cycle', () => {
    expect(
      topologicalOrder(
        ['a', 'b', 'c'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(
      topologicalOrder(
        ['a', 'b'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      ),
    ).toEqual([]);
  });
});

describe('sample divisor', () => {
  it('reads N and 1/N, defaulting to every PR', () => {
    expect(sampleDivisor(undefined)).toBe(1);
    expect(sampleDivisor(3)).toBe(3);
    expect(sampleDivisor('1/2')).toBe(2);
    expect(sampleDivisor('bogus')).toBe(1);
  });
});

let h: Harness;
let ctx: NextStepContext;
let worktree: string;
let finalizedWith: string[][];

beforeEach(() => {
  h = makeHarness();
  ctx = h.ctx;
  worktree = join(h.root, '.worktrees', 'aisdlc-900');
  mkdirSync(worktree, { recursive: true });
  finalizedWith = [];
  currentDoc = null;
  wire();
});
afterEach(() => h.cleanup());

let currentDoc: string | null = null;

/** Script `git rev-parse` and `git show` for the harness runner from `currentDoc`. */
function wire(): void {
  h.runner.on(/^git rev-parse --verify/, ok(BASE_SHA));
  h.runner.on(/^git show /, () => (currentDoc === null ? fail('no such path') : ok(currentDoc)));
}

function runnerFor(documentText: string | null): void {
  currentDoc = documentText;
}

describe('loadWorkflowFromBase', () => {
  it('reads the document with git show at the base SHA and records its digest', async () => {
    runnerFor(defaultText);
    const wf = await loadWorkflowFromBase({
      runner: ctx.runner,
      workDir: h.root,
      baseRef: 'origin/main',
      knownImpls: EXECUTE_IMPLS,
    });
    expect(wf.origin).toEqual({ kind: 'base', baseSha: BASE_SHA, path: WORKFLOW_PATH });
    expect(wf.baseSha).toBe(BASE_SHA);
    expect(wf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      h.runner.calls.some((c) => c.args.join(' ').includes(`show ${BASE_SHA}:${WORKFLOW_PATH}`)),
    ).toBe(true);
  });

  it('ignores a document that exists only in the working tree and runs the built-in default', async () => {
    mkdirSync(join(h.root, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(h.root, WORKFLOW_PATH), 'not: a workflow\n');
    runnerFor(null);
    const wf = await loadWorkflowFromBase({
      runner: ctx.runner,
      workDir: h.root,
      baseRef: 'origin/main',
      knownImpls: EXECUTE_IMPLS,
    });
    expect(wf.origin.kind).toBe('builtin');
    expect(wf.path).toBe('builtin:execute-task');
  });

  it('refuses when the base ref does not resolve', async () => {
    const r = await loadWorkflowFromBase({
      runner: async () => fail('bad ref'),
      workDir: h.root,
      baseRef: 'origin/nope',
      knownImpls: EXECUTE_IMPLS,
    }).catch((e) => e as WorkflowRefusal);
    expect((r as WorkflowRefusal).rule).toBe('not-from-base');
  });

  it('refuses a resume whose document no longer matches the recorded digest', async () => {
    runnerFor(defaultText);
    const r = await loadWorkflowFromBase({
      runner: ctx.runner,
      workDir: h.root,
      baseRef: BASE_SHA,
      knownImpls: EXECUTE_IMPLS,
      expect: { path: WORKFLOW_PATH, sha256: 'f'.repeat(64), baseSha: BASE_SHA },
    }).catch((e) => e as WorkflowRefusal);
    expect((r as WorkflowRefusal).message).toContain('no longer matches');
  });
});

// ── shadow nodes: gating false and sample ────────────────────────────

const DEV_JSON = JSON.stringify(DEV_RETURN);

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
    ],
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
  };
}

const approved = (): AggregatedVerdict => ({
  approved: true,
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  decision: 'APPROVED',
  verdicts: [],
  harnessNote: '',
  summary: '',
});

function deps(over: Partial<NextStepDeps> = {}): Partial<NextStepDeps> {
  return {
    initTask: async () => ({
      ok: true,
      branch: 'ai-sdlc/aisdlc-900-demo-task',
      worktreePath: worktree,
      task: makeTask(),
      fromStatus: 'To Do',
      promptFile: '/files/developer-prompt-1.md',
    }),
    prepareReview: async (_c, _s, round) => ({
      kind: 'spawn',
      review: reviewRound(round),
      classifierLine: 'c',
    }),
    finalizeReview: async (_c, _s, reports) => {
      finalizedWith.push(reports.map((r) => r.agent));
      return { ok: true, verdict: approved(), warnings: [] };
    },
    leasePreflight: () => ({ status: 'skipped', blocking: false, failing: [], message: '' }),
    preSignRebase: async () => ({ kind: 'skipped', reason: 'up to date' }),
    ship: async (_c, s) => {
      const done: DoneInstruction = {
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
      };
      return done;
    },
    ...over,
  };
}

function shadowDocument(sample: string | number | undefined): string {
  const doc = fresh();
  doc.spec.nodes.shadow = {
    kind: 'agent',
    role: 'staged-review',
    gating: false,
    ...(sample !== undefined ? { sample } : {}),
  } as never;
  doc.spec.edges.push({ from: 'plan', to: 'shadow' });
  return dump(doc, { lineWidth: -1, noRefs: true });
}

const shadowReport = {
  agent: 'staged-review',
  agentId: 's1',
  approved: false,
  findings: [{ severity: 'critical', file: 'x.ts', line: 1, message: 'shadow says no' }],
  summary: 'would block',
};
const codeReport = { agent: 'code-reviewer-codex', agentId: 'c1', approved: true, findings: [] };

async function runWithShadow(pr: number, sample: string | number | undefined) {
  ctx.env.AI_SDLC_PR_NUMBER = String(pr);
  runnerFor(shadowDocument(sample));
  let out = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
  const actions = [out.instruction];
  out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
  actions.push(out.instruction);
  const spawn = out.instruction;
  if (spawn.action !== 'spawn-reviewers') throw new Error(`unexpected ${JSON.stringify(spawn)}`);
  const reported = spawn.reviewers.some((r) => r.agent === 'staged-review')
    ? [codeReport, shadowReport]
    : [codeReport];
  out = await workflowNextStep(
    ctx,
    { task: 'AISDLC-900', result: JSON.stringify({ reviewers: reported }) },
    deps(),
  );
  actions.push(out.instruction);
  return { spawn, final: out.instruction, actions };
}

describe('non-gating (shadow) nodes (AC-3)', () => {
  it('never lets the shadow verdict reach aggregate, and writes it to the ledger with gating false', async () => {
    const { spawn, final } = await runWithShadow(2, '1/2');
    expect(spawn.reviewers.map((r) => r.agent)).toEqual(['code-reviewer-codex', 'staged-review']);
    expect(final).toMatchObject({ action: 'done', outcome: 'approved' });
    // The join and the verdict saw the gating reviewer only.
    expect(finalizedWith).toEqual([['code-reviewer-codex']]);
    const ledger = readLedger(ctx);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      node: 'shadow',
      role: 'staged-review',
      gating: false,
      approved: false,
      findings: { critical: 1 },
    });
    const records = readState(ctx.statePath)?.workflow?.records ?? [];
    expect(records.filter((r) => r.node === 'shadow').map((r) => r.status)).toEqual([
      'spawned',
      'ok',
    ]);
  });

  it('runs a sample 1/2 node on half the PRs and records the skip on the other half', async () => {
    const ran: number[] = [];
    const skipped: number[] = [];
    for (const pr of [1, 2, 3, 4]) {
      const { spawn } = await runWithShadow(pr, '1/2');
      (spawn.reviewers.some((r) => r.agent === 'staged-review') ? ran : skipped).push(pr);
      const records = readState(ctx.statePath)?.workflow?.records ?? [];
      const rec = records.find((r) => r.node === 'shadow');
      if (pr % 2 === 0) {
        expect(records.filter((r) => r.node === 'shadow').at(-1)?.status).toBe('ok');
      } else {
        expect(rec).toMatchObject({ status: 'skipped', gating: false });
        expect(rec?.detail).toContain('sample 1/2');
        expect(readLedger(ctx).at(-1)).toMatchObject({
          node: 'shadow',
          skipped: true,
          gating: false,
          sampleKey: { source: 'pr', value: pr },
        });
      }
      h.cleanup();
      h = makeHarness();
      ctx = h.ctx;
      worktree = join(h.root, '.worktrees', 'aisdlc-900');
      mkdirSync(worktree, { recursive: true });
      wire();
    }
    expect(ran).toEqual([2, 4]);
    expect(skipped).toEqual([1, 3]);
  });

  it('falls back to the task number when no PR number is known', async () => {
    delete ctx.env.AI_SDLC_PR_NUMBER;
    runnerFor(shadowDocument(2));
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(out.instruction.action).toBe('spawn-developer');
    const next = await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    // 900 % 2 == 0: the node runs
    expect(
      next.instruction.action === 'spawn-reviewers' &&
        next.instruction.reviewers.some((r) => r.agent === 'staged-review'),
    ).toBe(true);
  });
});

// ── host paths ───────────────────────────────────────────────────────

describe('workflowNextStep host paths', () => {
  it('is on by default and off only when the flag is exactly 0', () => {
    expect(workflowEngineEnabled({ AI_SDLC_WORKFLOW_ENGINE: '1' })).toBe(true);
    expect(workflowEngineEnabled({ AI_SDLC_WORKFLOW_ENGINE: 'true' })).toBe(true);
    expect(workflowEngineEnabled({})).toBe(true);
    expect(workflowEngineEnabled({ AI_SDLC_WORKFLOW_ENGINE: '0' })).toBe(false);
  });

  it('warns once per process when the escape hatch selects the Machine', () => {
    const lines: string[] = [];
    warnMachineDeprecated({}, (l) => lines.push(l));
    expect(lines).toHaveLength(0);
    warnMachineDeprecated({ AI_SDLC_WORKFLOW_ENGINE: '0' }, (l) => lines.push(l));
    warnMachineDeprecated({ AI_SDLC_WORKFLOW_ENGINE: '0' }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('deprecated');
  });

  it('persists one record per node run and exposes the run digest for signing', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    const reviewers = JSON.stringify({ reviewers: [codeReport] });
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: reviewers }, deps());
    expect(out.instruction.action).toBe('done');
    const wf = readState(ctx.statePath)?.workflow;
    expect(wf?.origin).toBe('builtin');
    expect(wf?.records.map((r) => `${r.node}:${r.status}`)).toEqual([
      'upkeep:ok',
      'validate:covered',
      'branch:covered',
      'worktree:covered',
      'flip:covered',
      'prompt:covered',
      'develop:spawned',
      'develop:ok',
      'parse:ok',
      'plan:ok',
      'review:spawned',
      'review:ok',
      'aggregate:ok',
      'finalize:ok',
      'ship:covered',
      'siblings:covered',
      'cleanup:covered',
    ]);
    expect(workflowDigestFromStateFile(ctx.statePath)).toEqual({
      path: 'builtin:execute-task',
      sha256: wf?.sha256,
      baseSha: BASE_SHA,
    });
    expect(ctx.env.AI_SDLC_WORKFLOW_STATE).toBe(ctx.statePath);
  });

  it('re-emits the pending instruction when called without a result', async () => {
    const first = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    const again = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(again.instruction).toEqual(first.instruction);
  });

  it('replays the stored terminal instruction for a finished run', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    const done = await workflowNextStep(
      ctx,
      { task: 'AISDLC-900', result: JSON.stringify({ reviewers: [codeReport] }) },
      deps(),
    );
    const replay = await workflowNextStep(ctx, { task: 'AISDLC-900', result: 'ignored' }, deps());
    expect(replay.instruction).toEqual(done.instruction);
  });

  it('refuses a state file that belongs to another task', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    const out = await workflowNextStep(ctx, { task: 'AISDLC-901', result: DEV_JSON }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain(
      'belongs to AISDLC-900',
    );
  });

  it('aborts when called without a result and nothing is pending', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    const state = readState(ctx.statePath);
    if (!state) throw new Error('no state');
    delete state.pending;
    writeFileSync(ctx.statePath, JSON.stringify(state));
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('no result');
  });

  it('refuses to resume a state file the Machine wrote', async () => {
    await nextStep(ctx, { task: 'AISDLC-900' }, deps());
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain(
      'written by the Machine',
    );
  });

  it('stops with the refusal and writes no state when the document is refused', async () => {
    const doc = fresh();
    doc.spec.anchors = [];
    runnerFor(dump(doc));
    const out = await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    expect(out.exitCode).toBe(1);
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('last-anchor');
    expect(() => readFileSync(ctx.statePath)).toThrow();
  });

  it('refuses a CCR sandbox, a bad argument and a refused init like the Machine does', async () => {
    const ccr = await workflowNextStep(
      { ...ctx, env: { CLAUDE_CODE_ENV: 'ccr' } },
      { task: 'AISDLC-900' },
      deps(),
    );
    expect(ccr.instruction.action === 'stop' && ccr.instruction.reason).toContain(
      'mcp__backlog__task_create',
    );
    const bad = await workflowNextStep(ctx, { task: 'not a task' }, deps());
    expect(bad.instruction.action === 'stop' && bad.instruction.reason).toContain('Accepted forms');
    const refused = await workflowNextStep(
      ctx,
      { task: 'AISDLC-900' },
      deps({ initTask: async () => ({ ok: false, reason: 'dependency preflight failed' }) }),
    );
    expect(refused.exitCode).toBe(1);
    expect(() => readFileSync(ctx.statePath)).toThrow();
  });

  it('aborts and reverts when a step throws after the task began', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    const out = await workflowNextStep(
      ctx,
      { task: 'AISDLC-900', result: DEV_JSON },
      deps({
        prepareReview: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(out.instruction).toMatchObject({ action: 'stop', outcome: 'aborted' });
    expect(out.instruction.action === 'stop' && out.instruction.reason).toContain('boom');
    expect(readState(ctx.statePath)?.phase).toBe('aborted');
  });

  it('stops when the review plan aborts', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    const out = await workflowNextStep(
      ctx,
      { task: 'AISDLC-900', result: DEV_JSON },
      deps({ prepareReview: async () => ({ kind: 'abort', reason: 'no diff' }) }),
    );
    expect(out.instruction.action === 'stop' && out.instruction.reason).toBe('no diff');
  });

  it('stops when finalize-review fails unrecoverably', async () => {
    await workflowNextStep(ctx, { task: 'AISDLC-900' }, deps());
    await workflowNextStep(ctx, { task: 'AISDLC-900', result: DEV_JSON }, deps());
    const out = await workflowNextStep(
      ctx,
      { task: 'AISDLC-900', result: JSON.stringify({ reviewers: [codeReport] }) },
      deps({ finalizeReview: async () => ({ ok: false, recoverable: false, reason: 'tampered' }) }),
    );
    expect(out.instruction.action === 'stop' && out.instruction.reason).toBe('tampered');
  });

  it('skips the developer and the parse when the resume decision is unchanged', async () => {
    const out = await workflowNextStep(
      ctx,
      { task: 'AISDLC-900' },
      deps({
        initTask: async () => ({
          ok: true,
          branch: 'b',
          worktreePath: worktree,
          task: makeTask(),
          fromStatus: 'To Do',
          promptFile: '/files/developer-prompt-1.md',
          resumed: true,
        }),
      }),
    );
    // decideResumeReview reads the worktree; an empty worktree is not "unchanged", so the
    // developer still runs, and the init bundle is recorded either way.
    expect(['spawn-developer', 'spawn-reviewers']).toContain(out.instruction.action);
    expect(readState(ctx.statePath)?.workflow?.records[0]).toMatchObject({
      node: 'upkeep',
      status: 'ok',
    });
  });
});
