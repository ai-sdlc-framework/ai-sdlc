/**
 * The staged review inside the next-step machine (RFC-0052, AISDLC-676).
 *
 * The `cli-staged-review` phases are scripted on the fake runner, so these tests pin the
 * wiring: which instruction each stage asks for, that every staged leaf is emitted before
 * the standalone security reviewer is spawned, that any refusal falls back to the existing
 * three-reviewer set, and that the staged verdict aggregates with the same blocking rules.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import { makeHarness, makeState, type Harness } from '../__test-helpers/next-step-fixtures.js';
import type { ReviewerVerdict } from '../types.js';
import { finalizeReview } from './review-finalize.js';
import { prepareReview } from './review-prepare.js';
import { advanceStagedRound } from './staged-round.js';
import type { NextStepState, ReviewRoundState, SpawnedReviewer } from './types.js';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n';
let h: Harness;
let state: NextStepState;
let artifacts: string;

function scriptReviewPlumbing(over: { incremental?: unknown } = {}): void {
  const r = h.runner;
  r.on(/diff --text/, ok(DIFF));
  r.on(/diff --numstat/, ok(''));
  r.on(/diff --name-only/, ok('src/a.ts\0'));
  r.on(/^which codex/, ok('/usr/bin/codex'));
  r.on(
    /cli-classify-pr\.mjs/,
    ok(JSON.stringify({ reviewers: ['testing', 'critic', 'security'], confidence: 0.9 })),
  );
  r.on(/gh pr view/, ok(JSON.stringify({ comments: [] })));
  r.on(/rev-parse HEAD/, ok('headsha\n'));
  r.on(
    /cli-incremental-decide\.mjs/,
    ok(
      JSON.stringify(
        over.incremental ?? {
          skip: false,
          deltaOnly: false,
          reason: 'no-marker',
          lastReviewedSha: null,
          currentContentHash: 'h1',
          deltaSize: 0,
        },
      ),
    ),
  );
  r.on(/generate-nonce/, ok('nonce-1\n'));
  r.on(/nonce-marker/, ok('<!-- ai-sdlc:nonce:nonce-1 -->\n'));
}

const stagedCalls = (): string[] =>
  h.runner.calls
    .filter((c) => c.args.some((a) => a.endsWith('cli-staged-review.mjs')))
    .map((c) => c.args[1]);

beforeEach(() => {
  h = makeHarness();
  state = makeState(h.root, { developer: null });
  artifacts = join(h.root, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  h.ctx.env.ARTIFACTS_DIR = artifacts;
});
afterEach(() => {
  vi.unstubAllEnvs();
  h.cleanup();
});

describe('prepareReview with reviewerSet staged', () => {
  beforeEach(() => {
    vi.stubEnv('AI_SDLC_REVIEWER_SET', 'staged');
    scriptReviewPlumbing();
  });

  it('asks for the planner alone and keeps the security reviewer for last', async () => {
    h.runner.on(
      /cli-staged-review\.mjs.* prepare|cli-staged-review\.mjs prepare/,
      ok(
        JSON.stringify({
          ok: true,
          plannerPromptPath: '/run/planner-prompt.md',
          baselineProbes: 4,
          seal: 'seal-0',
        }),
      ),
    );
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error(`expected spawn, got ${res.kind}`);
    expect(res.review.spawned.map((s) => s.agent)).toEqual(['review-planner']);
    expect(res.review.spawned[0].promptFile).toBe('/run/planner-prompt.md');
    expect(res.review.staged).toMatchObject({
      stage: 'plan',
      seal: 'seal-0',
      plannerAttempt: 1,
      security: { agent: 'security-reviewer', harness: 'claude-code' },
    });
    expect(res.review.nonce).toBe('nonce-1');
    // DEC-0149: the classifier's normal set runs beside the advisory staged verdict.
    expect(res.review.staged?.beside?.map((b) => b.reviewer).sort()).toEqual([
      'code-reviewer',
      'security-reviewer',
      'test-reviewer',
    ]);
    // Trusted backlog work only: the CLI is told the source kind.
    const prep = h.runner.calls.find((c) => c.args[1] === 'prepare');
    expect(prep?.args).toContain('--source-kind');
    expect(prep?.args).toContain('backlog');
  });

  it('fails closed: a refusal runs the existing reviewers and surfaces the rejections', async () => {
    h.runner.on(
      /cli-staged-review\.mjs/,
      ok(
        JSON.stringify({
          ok: false,
          reason: 'plan-rejected',
          rejections: [{ reason: 'uncovered-hunk' }],
          fallbackSet: 'three',
        }),
      ),
    );
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error(`expected spawn, got ${res.kind}`);
    expect(res.review.staged).toBeUndefined();
    expect(res.review.spawned.map((s) => s.reviewer).sort()).toEqual([
      'code-reviewer',
      'security-reviewer',
      'test-reviewer',
    ]);
    const warning = h.logs.find((l) => l.includes('cannot review this change'));
    expect(warning).toContain('plan-rejected');
    expect(warning).toContain('uncovered-hunk');
    expect(stagedCalls()).toEqual(['prepare']);
  });

  it('falls back when the CLI prints nothing usable', async () => {
    h.runner.on(/cli-staged-review\.mjs/, fail('boom', 1));
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.staged).toBeUndefined();
    expect(res.review.spawned).toHaveLength(3);
  });

  it('does not start the staged review when the incremental gate says unchanged', async () => {
    h.runner.calls.length = 0;
    const second = makeHarness();
    h.cleanup();
    h = second;
    state = makeState(h.root, { developer: null });
    h.ctx.env.ARTIFACTS_DIR = artifacts;
    mkdirSync(artifacts, { recursive: true });
    scriptReviewPlumbing({
      incremental: {
        skip: true,
        deltaOnly: false,
        reason: 'unchanged',
        lastReviewedSha: 'abc123',
        currentContentHash: 'h1',
        deltaSize: 0,
      },
    });
    const res = await prepareReview(h.ctx, state, 1);
    expect(res.kind).toBe('nothing-to-spawn');
    expect(stagedCalls()).toEqual([]);
  });
});

// ── advanceStagedRound ──────────────────────────────────────────────

const security: SpawnedReviewer = {
  reviewer: 'security-reviewer',
  agent: 'security-reviewer',
  harness: 'claude-code',
  leafModel: 'opus',
  promptFile: '/p/sec.md',
};

function stagedReview(over: Partial<ReviewRoundState['staged']> = {}): ReviewRoundState {
  return {
    round: 1,
    spawned: [
      {
        reviewer: 'review-planner',
        agent: 'review-planner',
        harness: 'claude-code',
        leafModel: 'fable',
        promptFile: '/run/planner-prompt.md',
      },
    ],
    autoApproved: [],
    headSha: 'headsha',
    nonce: 'nonce-1',
    harnessNote: '',
    classifier: { reviewers: ['testing', 'critic', 'security'], confidence: 1, fellOpen: false },
    incremental: {
      reason: 'no-marker',
      skip: false,
      deltaOnly: false,
      deltaSize: 0,
      lastReviewedSha: null,
      contentHash: 'h',
    },
    staged: {
      stage: 'plan',
      seal: 'seal-0',
      plannerAttempt: 1,
      plannerPromptFile: '/run/planner-prompt.md',
      plannerModel: 'fable',
      synthModel: 'fable',
      security,
      ...over,
    },
  };
}

function outputFile(name: string, text = '{"probes":[]}'): string {
  const file = join(h.root, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

describe('advanceStagedRound, plan stage', () => {
  it('asks for a corrected report when the planner output file is missing', async () => {
    state.review = stagedReview();
    const res = await advanceStagedRound(
      h.ctx,
      state,
      [{ agent: 'review-planner', agentId: 'p1', approved: false }],
      artifacts,
    );
    expect(res.kind).toBe('fix');
    expect(stagedCalls()).toEqual([]);
  });

  it('plans, persists the planner transcript, runs the probes and asks for the synthesizer', async () => {
    state.review = stagedReview();
    h.runner.on(
      (c, a) => a[1] === 'plan',
      ok(JSON.stringify({ status: 'planned', source: 'planner', probes: 5, seal: 'seal-1' })),
    );
    h.runner.on(
      (c, a) => a[1] === 'execute',
      ok(JSON.stringify({ probes: {}, transcripts: 2, seal: 'seal-2' })),
    );
    h.runner.on(
      (c, a) => a[1] === 'synth-prompt',
      ok(JSON.stringify({ promptPath: '/run/synth-prompt.md' })),
    );
    const res = await advanceStagedRound(
      h.ctx,
      state,
      [
        {
          agent: 'review-planner',
          agentId: 'p1',
          approved: false,
          outputFile: outputFile('p.txt'),
        },
      ],
      artifacts,
    );
    if (res.kind !== 'spawn') throw new Error(`expected spawn, got ${JSON.stringify(res)}`);
    expect(res.review.spawned.map((s) => s.agent)).toEqual(['review-synthesizer']);
    expect(res.review.spawned[0].promptFile).toBe('/run/synth-prompt.md');
    expect(res.review.staged).toMatchObject({ stage: 'synthesize', seal: 'seal-2' });
    // Each phase takes the seal the previous one printed.
    const seals = h.runner.calls
      .filter((c) => ['plan', 'execute', 'synth-prompt'].includes(String(c.args[1])))
      .map((c) => c.args[c.args.indexOf('--seal') + 1]);
    expect(seals).toEqual(['seal-0', 'seal-1', 'seal-2']);
    const persist = h.runner.calls.find((c) => c.command === 'bash');
    expect(persist?.args).toContain('review-planner');
  });

  it('asks the planner once more when the plan is rejected, with the reasons appended', async () => {
    const promptFile = outputFile('planner-prompt.md', 'PLAN PROMPT');
    state.review = stagedReview({ plannerPromptFile: promptFile });
    h.runner.on(
      (c, a) => a[1] === 'plan',
      ok(JSON.stringify({ status: 'retry', rejections: [], retryNote: 'cover hunk h3' })),
    );
    const res = await advanceStagedRound(
      h.ctx,
      state,
      [
        {
          agent: 'review-planner',
          agentId: 'p1',
          approved: false,
          outputFile: outputFile('p.txt'),
        },
      ],
      artifacts,
    );
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.staged?.plannerAttempt).toBe(2);
    expect(res.review.spawned[0].agent).toBe('review-planner');
    expect(res.review.spawned[0].promptFile).not.toBe(promptFile);
  });

  it('falls back when a phase answers ok:false (integrity failure)', async () => {
    state.review = stagedReview();
    h.runner.on(
      (c, a) => a[1] === 'plan',
      ok(JSON.stringify({ ok: false, reason: 'integrity-check-failed', fallbackSet: 'three' })),
    );
    const res = await advanceStagedRound(
      h.ctx,
      state,
      [
        {
          agent: 'review-planner',
          agentId: 'p1',
          approved: false,
          outputFile: outputFile('p.txt'),
        },
      ],
      artifacts,
    );
    expect(res).toEqual({ kind: 'fallback', reason: 'integrity-check-failed' });
  });

  it('falls back when the probes cannot run', async () => {
    state.review = stagedReview();
    h.runner.on(
      (c, a) => a[1] === 'plan',
      ok(JSON.stringify({ status: 'planned', source: 'planner', probes: 1, seal: 's1' })),
    );
    h.runner.on(
      (c, a) => a[1] === 'execute',
      ok(JSON.stringify({ ok: false, reason: 'adapter-cannot-enforce-scope' })),
    );
    const res = await advanceStagedRound(
      h.ctx,
      state,
      [
        {
          agent: 'review-planner',
          agentId: 'p1',
          approved: false,
          outputFile: outputFile('p.txt'),
        },
      ],
      artifacts,
    );
    expect(res).toEqual({ kind: 'fallback', reason: 'adapter-cannot-enforce-scope' });
  });
});

describe('advanceStagedRound, synthesize stage', () => {
  const leaf = (stage: string, name: string) => ({
    stage,
    reviewer: 'staged-review',
    transcriptPath: `/t/${name}.jsonl`,
    verdictPath: `/v/${name}.json`,
    harness: stage === 'execute' ? 'codex' : 'claude-code',
    model: `${name}-model`,
  });
  const reviewerVerdict: ReviewerVerdict = {
    agentId: 'staged-review',
    harness: 'claude-code',
    approved: true,
    findings: [],
    summary: 'ok',
  };

  function synthState(): void {
    state.review = stagedReview({ stage: 'synthesize', seal: 'seal-2' });
    state.review.spawned = [
      {
        reviewer: 'review-synthesizer',
        agent: 'review-synthesizer',
        harness: 'claude-code',
        leafModel: 'fable',
        promptFile: '/run/synth-prompt.md',
      },
    ];
    state.iteration = 1;
  }
  const report = () => [
    {
      agent: 'review-synthesizer',
      agentId: 's1',
      approved: false,
      outputFile: outputFile('s.txt'),
    },
  ];

  it('emits one leaf per manifest entry with its stage, then asks for the security reviewer', async () => {
    synthState();
    const manifest = [
      leaf('plan', 'planner'),
      leaf('execute', 'probe-1'),
      leaf('synthesize', 'synth'),
    ];
    for (const l of manifest) {
      h.present.add(l.transcriptPath);
      h.present.add(l.verdictPath);
    }
    h.runner.on(
      (c, a) => a[1] === 'finalize',
      ok(JSON.stringify({ ok: true, reviewerVerdict, leaves: manifest, dropped: 2 })),
    );
    const res = await advanceStagedRound(h.ctx, state, report(), artifacts);
    if (res.kind !== 'spawn') throw new Error(`expected spawn, got ${JSON.stringify(res)}`);

    const emits = h.runner.calls.filter((c) => c.args.includes('emit-leaf'));
    expect(emits.map((c) => c.args[c.args.indexOf('--stage') + 1])).toEqual([
      'plan',
      'execute',
      'synthesize',
    ]);
    for (const e of emits) {
      expect(e.args[e.args.indexOf('--reviewer') + 1]).toBe('staged-review');
      expect(e.args[e.args.indexOf('--nonce') + 1]).toBe('nonce-1');
    }
    // The security reviewer is spawned only after every leaf was emitted.
    expect(res.review.spawned.map((s) => s.agent)).toEqual(['security-reviewer']);
    expect(res.review.staged).toMatchObject({ stage: 'security', verdict: reviewerVerdict });
  });

  it('spawns the whole normal set beside the staged verdict when one was recorded', async () => {
    const code: SpawnedReviewer = {
      ...security,
      reviewer: 'code-reviewer',
      agent: 'code-reviewer',
    };
    const test: SpawnedReviewer = {
      ...security,
      reviewer: 'test-reviewer',
      agent: 'test-reviewer',
    };
    state.review = stagedReview({ stage: 'synthesize', beside: [code, test, security] });
    const synth = leaf('synthesize', 'synth');
    h.present.add(synth.transcriptPath);
    h.present.add(synth.verdictPath);
    h.runner.on(
      (c, a) => a[1] === 'finalize',
      ok(JSON.stringify({ ok: true, reviewerVerdict, leaves: [synth], dropped: 0 })),
    );
    const res = await advanceStagedRound(h.ctx, state, report(), artifacts);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.spawned.map((s) => s.agent)).toEqual([
      'code-reviewer',
      'test-reviewer',
      'security-reviewer',
    ]);
  });

  it('marks the staged verdict not approved when a plan leaf cannot be emitted', async () => {
    synthState();
    const plan = leaf('plan', 'planner');
    const synth = leaf('synthesize', 'synth');
    // The plan leaf has no transcript on disk; the synthesize leaf is fine.
    h.present.add(synth.transcriptPath);
    h.present.add(synth.verdictPath);
    h.runner.on(
      (c, a) => a[1] === 'finalize',
      ok(JSON.stringify({ ok: true, reviewerVerdict, leaves: [plan, synth], dropped: 0 })),
    );
    const res = await advanceStagedRound(h.ctx, state, report(), artifacts);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.staged?.verdict?.approved).toBe(false);
  });

  it('marks the staged verdict not approved when its synthesize leaf cannot be emitted', async () => {
    synthState();
    const synth = leaf('synthesize', 'synth');
    // No transcript on disk for the synthesize leaf.
    h.runner.on(
      (c, a) => a[1] === 'finalize',
      ok(JSON.stringify({ ok: true, reviewerVerdict, leaves: [synth], dropped: 0 })),
    );
    const res = await advanceStagedRound(h.ctx, state, report(), artifacts);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.staged?.verdict?.approved).toBe(false);
    expect(res.review.staged?.verdict?.findings.at(-1)?.severity).toBe('major');
  });

  it('falls back when finalize refuses the verdict', async () => {
    synthState();
    h.runner.on(
      (c, a) => a[1] === 'finalize',
      ok(
        JSON.stringify({
          ok: false,
          reason: 'invalid-verdict',
          rejections: [],
          fallbackSet: 'three',
        }),
      ),
    );
    const res = await advanceStagedRound(h.ctx, state, report(), artifacts);
    expect(res).toEqual({ kind: 'fallback', reason: 'invalid-verdict' });
    expect(h.runner.calls.some((c) => c.args.includes('emit-leaf'))).toBe(false);
  });

  it('falls back when the synthesizer transcript cannot be persisted', async () => {
    synthState();
    h.runner.on((c) => c === 'bash', fail('no transcript', 1));
    const res = await advanceStagedRound(h.ctx, state, report(), artifacts);
    expect(res).toEqual({ kind: 'fallback', reason: 'synthesizer-transcript-not-persisted' });
  });

  it('aborts when there is no staged round in state', async () => {
    state.review = null;
    const res = await advanceStagedRound(h.ctx, state, [], artifacts);
    expect(res.kind).toBe('abort');
  });
});

// ── Step 8: a set of one aggregates with today's blocking rules ───────

describe('finalizeReview with the staged verdict', () => {
  function securityRound(staged: ReviewerVerdict): void {
    const review = stagedReview({ stage: 'security', verdict: staged });
    review.spawned = [security];
    state.review = review;
    state.iteration = 1;
  }
  const secReport = [
    { agent: 'security-reviewer', agentId: 'sec1', approved: true, findings: [], summary: 'fine' },
  ];
  const stagedVerdict = (approved: boolean): ReviewerVerdict => ({
    agentId: 'staged-review',
    harness: 'claude-code',
    approved,
    findings: approved ? [] : [{ severity: 'critical', file: 'a.ts', line: 1, message: 'bad' }],
    summary: 's',
  });
  beforeEach(() => {
    const dir = join(state.worktreePath, '.ai-sdlc');
    h.present.add(join(dir, 'transcripts', 'aisdlc-900', 'security-reviewer.jsonl'));
    h.present.add(join(dir, 'verdicts', 'security-reviewer-aisdlc-900.json'));
  });

  it('blocks on a critical staged finding', async () => {
    securityRound(stagedVerdict(false));
    const fin = await finalizeReview(h.ctx, state, secReport);
    if (!fin.ok) throw new Error(fin.reason);
    expect(fin.verdict.decision).not.toBe('APPROVED');
    expect(fin.verdict.counts.critical).toBe(1);
    expect(fin.verdict.verdicts.map((v) => v.agentId)).toEqual([
      'staged-review',
      'security-reviewer',
    ]);
  });

  it('approves when the staged verdict and the security reviewer approve', async () => {
    securityRound(stagedVerdict(true));
    const fin = await finalizeReview(h.ctx, state, secReport);
    if (!fin.ok) throw new Error(fin.reason);
    expect(fin.verdict.decision).toBe('APPROVED');
    expect(fin.verdict.counts.critical).toBe(0);
  });
});
