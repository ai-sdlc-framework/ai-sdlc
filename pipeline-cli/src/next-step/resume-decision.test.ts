import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import { makeHarness, makeState, type Harness } from '../__test-helpers/next-step-fixtures.js';
import { decideResumeReview } from './resume-decision.js';
import { prepareReview } from './review-prepare.js';

const SHA = 'a'.repeat(40);
const LAST = 'b'.repeat(40);
const PID = 'c'.repeat(40);
const ENVELOPE = `.ai-sdlc/attestations/${PID}.v6.dsse.json`;

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

function script(delta = 'docs/readme.md\0', envelope: boolean | string = true): void {
  const r = h.runner;
  r.on(
    /log .*--diff-filter=A/,
    ok(typeof envelope === 'string' ? envelope : envelope ? `${ENVELOPE}\n` : ''),
  );
  r.on(/show HEAD:/, ok(JSON.stringify({ subject: { digest: { sha1: LAST } } })));
  r.on(/cat-file -e/, ok());
  r.on(/rev-parse HEAD/, ok(`${SHA}\n`));
  r.on(/-base origin/, ok(`${'d'.repeat(40)}\n`));
  r.on(/show origin\/.*trusted-reviewers/, ok('reviewers: []\n'));
  r.on(/diff --name-only/, ok(delta));
}

const opts = (pid: string | null, verified = true) => ({
  currentPatchId: () => pid,
  requireThree: false,
  verifyAt: async () => verified,
});

describe('decideResumeReview (AISDLC-947)', () => {
  it('unchanged patch id skips every agent', async () => {
    script();
    const d = await decideResumeReview(h.ctx, h.root, opts(PID));
    expect(d).toEqual({ branch: 'unchanged', note: 'review-skipped: unchanged', lastHead: LAST });
  });

  it('chore-only delta gets the correctness reviewer alone', async () => {
    script('docs/readme.md\0');
    const d = await decideResumeReview(h.ctx, h.root, opts('e'.repeat(40)));
    expect(d.branch).toBe('delta');
    if (d.branch !== 'delta') return;
    expect(d.reviewers).toEqual(['correctness-reviewer']);
    expect(d.note).toBe('review-delta: correctness-reviewer');
  });

  it('trust-chain delta brings the security reviewer', async () => {
    script('.github/workflows/ci.yml\0');
    const d = await decideResumeReview(h.ctx, h.root, opts('e'.repeat(40)));
    expect(d.branch === 'delta' && d.reviewers.includes('security-reviewer')).toBe(true);
  });

  it('reviewerSet three keeps all three on a docs delta', async () => {
    script('docs/readme.md\0');
    const d = await decideResumeReview(h.ctx, h.root, {
      currentPatchId: () => 'e'.repeat(40),
      requireThree: true,
      verifyAt: async () => true,
    });
    expect(d.branch === 'delta' && d.reviewers.includes('security-reviewer')).toBe(true);
  });

  it('no prior attestation runs the full pipeline', async () => {
    script('docs/readme.md\0', false);
    expect(await decideResumeReview(h.ctx, h.root, opts(PID))).toEqual({
      branch: 'full',
      note: 'review-full',
    });
  });

  it('falls back to full when the patch id cannot be computed', async () => {
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts(null))).branch).toBe('full');
  });

  it('falls back to full when the delta cannot be read', async () => {
    h.runner.on(/diff --name-only/, fail('x'));
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts('e'.repeat(40)))).branch).toBe('full');
  });

  it('a forged or unverifiable envelope never skips review (unchanged)', async () => {
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts(PID, false))).branch).toBe('full');
  });

  it('a forged or unverifiable envelope never bases a delta', async () => {
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts('e'.repeat(40), false))).branch).toBe(
      'full',
    );
  });

  it('verifies the unchanged envelope at HEAD and the delta base at the attested head', async () => {
    script();
    const seen: string[] = [];
    const verifyAt = async (head: string) => (seen.push(head), true);
    await decideResumeReview(h.ctx, h.root, { ...opts(PID), verifyAt });
    await decideResumeReview(h.ctx, h.root, { ...opts('e'.repeat(40)), verifyAt });
    expect(seen).toEqual([SHA, LAST]);
  });

  it('verifies against trusted-reviewers.yaml from the target ref, not the worktree', async () => {
    script();
    const yamls: string[] = [];
    const verifyAt = async (_h: string, _b: string, _c: string, y: string) => (yamls.push(y), true);
    await decideResumeReview(h.ctx, h.root, { ...opts(PID), verifyAt });
    expect(yamls).toEqual(['reviewers: []\n']);
    expect(
      h.runner.calls.some((c: { args: string[] }) => c.args.join(' ').includes('show origin/')),
    ).toBe(true);
  });

  it('falls back to full when the trusted ref has no trusted-reviewers.yaml', async () => {
    h.runner.on(/show origin\/.*trusted-reviewers/, fail('missing'));
    script();
    expect((await decideResumeReview(h.ctx, h.root, opts(PID))).branch).toBe('full');
  });

  it('picks the newest of two envelopes on the branch (git log is newest first)', async () => {
    const OLD = 'f'.repeat(40);
    script('docs/readme.md\0', `${ENVELOPE}\n.ai-sdlc/attestations/${OLD}.v6.dsse.json\n`);
    const d = await decideResumeReview(h.ctx, h.root, opts(PID));
    expect(d.branch).toBe('unchanged');
    const d2 = await decideResumeReview(h.ctx, h.root, opts(OLD));
    expect(d2.branch).toBe('delta');
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
