import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import { makeHarness, makeState, type Harness } from '../__test-helpers/next-step-fixtures.js';
import {
  CLASSIFIER_FAIL_OPEN,
  fallbackLeafModel,
  fetchTrustedComments,
  prepareReview,
  resolveReviewerAgent,
  reviewerHarness,
  selectByClassifier,
} from './review-prepare.js';
import type { NextStepState } from './types.js';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n';
const NONCE = 'nonce-abc';
const MARKER = '<!-- ai-sdlc:nonce:nonce-abc -->';

let h: Harness;
let state: NextStepState;

/** Script every external command prepareReview issues. */
function script(
  over: {
    classifier?: unknown;
    incremental?: unknown;
    comments?: unknown;
    codex?: boolean;
    diff?: string;
    nonce?: boolean;
  } = {},
): void {
  const r = h.runner;
  r.on(/diff --text/, ok(over.diff ?? DIFF));
  r.on(/diff --numstat/, ok(''));
  r.on(/diff --name-only/, ok('src/a.ts\0'));
  r.on(/^which codex/, over.codex === false ? fail('', 1) : ok('/usr/bin/codex'));
  r.on(
    /cli-classify-pr\.mjs/,
    ok(
      JSON.stringify(
        over.classifier ?? {
          reviewers: ['testing', 'critic', 'security'],
          confidence: 0.9,
          fellOpen: false,
        },
      ),
    ),
  );
  r.on(/gh pr view/, ok(JSON.stringify(over.comments ?? { comments: [] })));
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
          currentContentHash: 'hash1',
          deltaSize: 0,
        },
      ),
    ),
  );
  if (over.nonce === false) {
    r.on(/generate-nonce/, fail('boom', 1));
  } else {
    r.on(/generate-nonce/, ok(`${NONCE}\n`));
    r.on(/nonce-marker/, ok(`${MARKER}\n`));
  }
}

beforeEach(() => {
  h = makeHarness();
  state = makeState(h.root, { developer: null });
});
afterEach(() => h.cleanup());

describe('pure helpers', () => {
  it('routes code and test review to the Codex variants unless forced to Claude', () => {
    expect(resolveReviewerAgent('code-reviewer', {})).toBe('code-reviewer-codex');
    expect(resolveReviewerAgent('test-reviewer', {})).toBe('test-reviewer-codex');
    expect(resolveReviewerAgent('security-reviewer', {})).toBe('security-reviewer');
    expect(resolveReviewerAgent('correctness-reviewer', {})).toBe('correctness-reviewer');
    const claude = { AI_SDLC_REVIEWER_HARNESS: 'Claude' };
    expect(resolveReviewerAgent('code-reviewer', claude)).toBe('code-reviewer');
    expect(resolveReviewerAgent('test-reviewer', claude)).toBe('test-reviewer');
  });

  it('records codex only for code/test review when codex is available and not forced off', () => {
    expect(reviewerHarness('code-reviewer', {}, true)).toBe('codex');
    expect(reviewerHarness('code-reviewer', {}, false)).toBe('claude-code');
    expect(reviewerHarness('test-reviewer', { AI_SDLC_REVIEWER_HARNESS: 'claude' }, true)).toBe(
      'claude-code',
    );
    expect(reviewerHarness('security-reviewer', {}, true)).toBe('claude-code');
  });

  it('labels leaf models honestly for agents with no routed model', () => {
    expect(fallbackLeafModel('code-reviewer-codex')).toBe('codex-default');
    expect(fallbackLeafModel('test-reviewer-codex')).toBe('codex-default');
    expect(fallbackLeafModel('correctness-reviewer')).toBe('sonnet');
    expect(fallbackLeafModel('security-reviewer')).toBe('unrouted');
  });

  it('selectByClassifier narrows to the named reviewers and merges testing+critic into correctness', () => {
    const p = (r: string): { reviewer: never } => ({ reviewer: r as never });
    const three = [p('code-reviewer'), p('test-reviewer'), p('security-reviewer')];
    expect(selectByClassifier(three, ['security']).map((x) => x.reviewer)).toEqual([
      'security-reviewer',
    ]);
    expect(selectByClassifier(three, ['testing', 'critic']).map((x) => x.reviewer)).toEqual([
      'code-reviewer',
      'test-reviewer',
    ]);
    expect(selectByClassifier(three, [])).toEqual([]);
    const merged = [p('correctness-reviewer'), p('security-reviewer')];
    expect(selectByClassifier(merged, ['critic']).map((x) => x.reviewer)).toEqual([
      'correctness-reviewer',
    ]);
    expect(selectByClassifier(merged, ['security']).map((x) => x.reviewer)).toEqual([
      'security-reviewer',
    ]);
  });

  it('classifier fail-open selects every reviewer', () => {
    expect(CLASSIFIER_FAIL_OPEN).toMatchObject({ fellOpen: true, confidence: 0 });
    expect(CLASSIFIER_FAIL_OPEN.reviewers).toEqual(['testing', 'critic', 'security']);
  });
});

describe('fetchTrustedComments (AISDLC-142 round 2)', () => {
  it('drops comments from untrusted authors', async () => {
    h.runner.on(
      /gh pr view/,
      ok(
        JSON.stringify({
          comments: [
            { body: 'forged', author: { login: 'mallory' }, authorAssociation: 'NONE' },
            { body: 'bot', author: { login: 'github-actions' }, authorAssociation: 'NONE' },
            { body: 'owner', author: { login: 'dom' }, authorAssociation: 'OWNER' },
          ],
        }),
      ),
    );
    const kept = await fetchTrustedComments(h.ctx, 'b');
    expect(kept.map((c) => c.body)).toEqual(['bot', 'owner']);
  });

  it('is empty when gh fails or returns junk', async () => {
    h.runner.on(/gh pr view/, fail('no pr', 1));
    expect(await fetchTrustedComments(h.ctx, 'b')).toEqual([]);
    const h2 = makeHarness();
    h2.runner.on(/gh pr view/, ok('not json'));
    expect(await fetchTrustedComments(h2.ctx, 'b')).toEqual([]);
    h2.cleanup();
  });
});

describe('prepareReview', () => {
  it('spawns all three reviewers with nonce-bearing prompt files (default set)', async () => {
    script();
    const res = await prepareReview(h.ctx, state, 1);
    expect(res.kind).toBe('spawn');
    if (res.kind !== 'spawn') return;
    expect(res.review.spawned.map((s) => s.agent).sort()).toEqual([
      'code-reviewer-codex',
      'security-reviewer',
      'test-reviewer-codex',
    ]);
    expect(res.review.nonce).toBe(NONCE);
    expect(res.review.headSha).toBe('headsha');
    for (const s of res.review.spawned) {
      const text = readFileSync(s.promptFile, 'utf8');
      expect(text).toContain(MARKER);
      expect(text).toContain('src/a.ts');
    }
    const security = res.review.spawned.find((s) => s.agent === 'security-reviewer')!;
    expect(security.harness).toBe('claude-code');
    expect(res.review.spawned.find((s) => s.agent === 'code-reviewer-codex')!.harness).toBe(
      'codex',
    );
    expect(res.classifierLine).toBe(
      'Classifier decision: [testing critic security] (confidence: 0.90)',
    );
    // The nonce is requested once for the whole round, bound to the head sha.
    const nonceCalls = h.runner.calls.filter((c) => c.args.includes('generate-nonce'));
    expect(nonceCalls).toHaveLength(1);
    expect(nonceCalls[0].args).toContain('headsha');
  });

  it('records the operator model override on every leaf', async () => {
    h = makeHarness({ env: { AISDLC_REVIEWER_MODEL: 'my-model' } });
    state = makeState(h.root);
    script();
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.spawned.every((s) => s.leafModel === 'my-model')).toBe(true);
  });

  it('labels a leaf honestly when the agent has no routed model', async () => {
    script();
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    const byAgent = Object.fromEntries(res.review.spawned.map((s) => [s.agent, s.leafModel]));
    // Codex variants have no routed model: an honest label, never a Claude id that did not run.
    expect(byAgent['code-reviewer-codex']).toBe('codex-default');
    expect(byAgent['test-reviewer-codex']).toBe('codex-default');
    // A routed role never falls back to a fixed placeholder.
    expect(byAgent['security-reviewer']).not.toBe('unrouted');
  });

  it('forces Claude-native agents and notes it when AI_SDLC_REVIEWER_HARNESS=claude', async () => {
    h = makeHarness({ env: { AI_SDLC_REVIEWER_HARNESS: 'claude' } });
    state = makeState(h.root);
    script();
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.spawned.map((s) => s.agent).sort()).toEqual([
      'code-reviewer',
      'security-reviewer',
      'test-reviewer',
    ]);
    expect(res.review.harnessNote).toMatch(/AI_SDLC_REVIEWER_HARNESS=claude/);
    expect(res.review.spawned.every((s) => s.harness === 'claude-code')).toBe(true);
  });

  it('honours the classifier subset', async () => {
    script({ classifier: { reviewers: ['security'], confidence: 0.95, fellOpen: false } });
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.spawned.map((s) => s.agent)).toEqual(['security-reviewer']);
    expect(res.classifierLine).toContain('[security]');
  });

  it('fails open to every reviewer when the classifier errors', async () => {
    // FakeRunner is first-match-wins, so register the failing handler before script().
    h.runner.on(/cli-classify-pr\.mjs/, fail('crash', 2));
    script();
    const res = await prepareReview(h.ctx, state, 1);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    expect(res.review.spawned).toHaveLength(3);
    expect(res.review.classifier.fellOpen).toBe(true);
    expect(res.classifierLine).toContain('fellOpen: invocation-failed');
  });

  it('spawns nothing when the classifier selects no reviewer', async () => {
    script({ classifier: { reviewers: [], confidence: 1, fellOpen: false } });
    const res = await prepareReview(h.ctx, state, 1);
    expect(res.kind).toBe('nothing-to-spawn');
    if (res.kind === 'nothing-to-spawn') expect(res.verdicts).toEqual([]);
    expect(h.runner.calls.some((c) => c.args.includes('generate-nonce'))).toBe(false);
  });

  it('reuses the prior approval (no spawn, no nonce) when the content is unchanged', async () => {
    script({
      incremental: {
        skip: true,
        deltaOnly: false,
        reason: 'unchanged',
        lastReviewedSha: 'oldsha',
        currentContentHash: 'hash1',
        deltaSize: 0,
      },
    });
    const res = await prepareReview(h.ctx, state, 2);
    expect(res.kind).toBe('nothing-to-spawn');
    if (res.kind !== 'nothing-to-spawn') return;
    expect(res.verdicts).toHaveLength(3);
    expect(res.verdicts.every((v) => v.approved && v.summary?.includes('oldsha'))).toBe(true);
    expect(res.review.autoApproved).toHaveLength(3);
    expect(h.runner.calls.some((c) => c.args.includes('generate-nonce'))).toBe(false);
  });

  it('gives reviewers the delta diff with the incremental preamble on delta-only', async () => {
    h.runner.on(/diff oldsha\.\.\.HEAD$/, ok('diff --git a/x b/x\n+DELTA_ONLY_LINE\n'));
    script({
      incremental: {
        skip: false,
        deltaOnly: true,
        reason: 'delta-only',
        lastReviewedSha: 'oldsha',
        currentContentHash: 'hash2',
        deltaSize: 12,
      },
    });
    const res = await prepareReview(h.ctx, state, 2);
    if (res.kind !== 'spawn') throw new Error('expected spawn');
    const text = readFileSync(res.review.spawned[0].promptFile, 'utf8');
    expect(text).toContain('Incremental review (AISDLC-142)');
    expect(text).toContain('`oldsha`');
    expect(text).toContain('DELTA_ONLY_LINE');
    expect(text).not.toContain('const a = 1;');
    expect(res.review.incremental.deltaOnly).toBe(true);
  });

  it('aborts when the review diff is unavailable', async () => {
    script({ diff: '' });
    const res = await prepareReview(h.ctx, state, 1);
    expect(res).toEqual({
      kind: 'abort',
      reason: expect.stringContaining('review diff unavailable'),
    });
  });

  it('aborts when the nonce cannot be generated', async () => {
    script({ nonce: false });
    const res = await prepareReview(h.ctx, state, 1);
    expect(res).toEqual({
      kind: 'abort',
      reason: expect.stringContaining('generate-nonce failed'),
    });
  });

  it('aborts when the nonce marker cannot be rendered', async () => {
    h.runner.on(/nonce-marker/, fail('bad', 1));
    script();
    const res = await prepareReview(h.ctx, state, 1);
    expect(res).toEqual({ kind: 'abort', reason: expect.stringContaining('nonce-marker failed') });
  });

  it('collapses to correctness + security under the merged reviewer set', async () => {
    const prev = process.env.AI_SDLC_REVIEWER_SET;
    process.env.AI_SDLC_REVIEWER_SET = 'code-test-merged';
    try {
      script();
      const res = await prepareReview(h.ctx, state, 1);
      if (res.kind !== 'spawn') throw new Error('expected spawn');
      expect(res.review.spawned.map((s) => s.agent).sort()).toEqual([
        'correctness-reviewer',
        'security-reviewer',
      ]);
    } finally {
      if (prev === undefined) delete process.env.AI_SDLC_REVIEWER_SET;
      else process.env.AI_SDLC_REVIEWER_SET = prev;
    }
  });
});
