import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import { makeHarness, makeState, type Harness } from '../__test-helpers/next-step-fixtures.js';
import type { HeadVerdictStatus } from './head-envelope.js';
import { decideResumeReview, type ResumeDecisionOpts } from './resume-decision.js';
import { prepareReview } from './review-prepare.js';

const SHA = 'a'.repeat(40);
const LAST = 'b'.repeat(40);

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const missing: HeadVerdictStatus = {
  status: 'missing',
  headSha: SHA,
  ref: `refs/ai-sdlc/verdicts/${SHA}`,
  reason: 'no record',
};

function opts(
  status: HeadVerdictStatus,
  earlier: string[] = [LAST],
  extra: Partial<ResumeDecisionOpts> = {},
): ResumeDecisionOpts {
  return {
    requireThree: false,
    headVerdict: async () => status,
    earlierHeads: async () => earlier,
    ...extra,
  };
}

function script(delta = 'docs/readme.md\0'): void {
  h.runner.on(/cat-file -e/, ok());
  h.runner.on(/rev-parse HEAD/, ok(`${SHA}\n`));
  h.runner.on(/diff --name-only/, ok(delta));
}

describe('decideResumeReview (AISDLC-947, RFC-0061 Phase 2)', () => {
  it('a head with a verdict record skips every agent', async () => {
    const d = await decideResumeReview(
      h.ctx,
      h.root,
      opts({ status: 'present', headSha: SHA, ref: 'r' }),
    );
    expect(d).toEqual({
      branch: 'unchanged',
      note: 'review-skipped: verdict record present',
      lastHead: SHA,
    });
  });

  it('a carried-forward verdict skips every agent and names its source', async () => {
    const d = await decideResumeReview(
      h.ctx,
      h.root,
      opts({ status: 'carried', headSha: SHA, from: LAST }),
    );
    expect(d).toEqual({
      branch: 'unchanged',
      note: `review-skipped: verdict carried forward from ${LAST}`,
      lastHead: LAST,
    });
  });

  it('developerRound bypasses the unchanged shortcut even with a record (AISDLC-1053)', async () => {
    const d = await decideResumeReview(h.ctx, h.root, {
      ...opts({ status: 'present', headSha: SHA, ref: 'r' }),
      developerRound: true,
    });
    expect(d.branch).toBe('developer-round');
  });

  it('chore-only delta gets the correctness reviewer alone', async () => {
    script('docs/readme.md\0');
    const d = await decideResumeReview(h.ctx, h.root, opts(missing));
    expect(d.branch).toBe('delta');
    if (d.branch !== 'delta') return;
    expect(d.lastHead).toBe(LAST);
    expect(d.reviewers).toEqual(['correctness-reviewer']);
    expect(d.note).toBe('review-delta: correctness-reviewer');
  });

  it('trust-chain delta brings the security reviewer', async () => {
    script('.github/workflows/ci.yml\0');
    const d = await decideResumeReview(h.ctx, h.root, opts(missing));
    expect(d.branch === 'delta' && d.reviewers.includes('security-reviewer')).toBe(true);
  });

  it('reviewerSet three keeps all three on a docs delta', async () => {
    script('docs/readme.md\0');
    const d = await decideResumeReview(
      h.ctx,
      h.root,
      opts(missing, [LAST], { requireThree: true }),
    );
    expect(d.branch === 'delta' && d.reviewers.includes('security-reviewer')).toBe(true);
  });

  it('no usable earlier record runs the full pipeline (carried forward, else review)', async () => {
    script();
    expect(await decideResumeReview(h.ctx, h.root, opts(missing, []))).toEqual({
      branch: 'full',
      note: 'review-full',
    });
  });

  it('an earlier head that is not in the worktree is skipped', async () => {
    h.runner.on(/cat-file -e/, fail('missing', 128));
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts(missing))).branch).toBe('full');
  });

  it('an unknown head status falls through to the earlier-head delta or full', async () => {
    script();
    const d = await decideResumeReview(h.ctx, h.root, opts({ status: 'unknown', headSha: '' }));
    expect(d.branch).toBe('delta');
  });

  it('falls back to full when the delta cannot be read or is empty', async () => {
    h.runner.on(/diff --name-only/, fail('x'));
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts(missing))).branch).toBe('full');
    const h2 = makeHarness();
    h2.runner.on(/cat-file -e/, ok());
    h2.runner.on(/rev-parse HEAD/, ok(`${SHA}\n`));
    h2.runner.on(/diff --name-only/, ok(''));
    expect((await decideResumeReview(h2.ctx, h2.root, opts(missing))).branch).toBe('full');
    h2.cleanup();
  });

  it('never throws: a failing verdict lookup is a full review', async () => {
    const d = await decideResumeReview(h.ctx, h.root, {
      headVerdict: async () => {
        throw new Error('boom');
      },
    });
    expect(d.branch).toBe('full');
  });

  it('prepareReview spawns nothing and records the note on an unchanged resume', async () => {
    const r = h.runner;
    r.on(/diff --text/, ok('diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n'));
    r.on(/diff --name-only/, ok('src/a.ts\0'));
    r.on(/rev-parse HEAD/, ok('headsha\n'));
    const state = makeState(h.root, {
      developer: null,
      resumeReview: { branch: 'unchanged', note: 'review-skipped: unchanged', lastHead: LAST },
    });
    const res = await prepareReview(h.ctx, state, 1);
    expect(res.kind).toBe('nothing-to-spawn');
    if (res.kind !== 'nothing-to-spawn') return;
    expect(res.verdicts.length).toBeGreaterThan(0);
    expect(res.review.harnessNote).toContain('review-skipped: unchanged');
    expect(r.calls.some((c) => c.args.join(' ').includes('cli-classify-pr'))).toBe(false);
  });
});
