import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  REVIEW_MARKER,
  SETTING_NAME,
  buildReviewBody,
  createFetchApi,
  postAttestationReview,
} from './post-attestation-review.mjs';

const REPO = 'org/repo';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

function fakeApi(reviews = [], opts = {}) {
  const calls = { created: [], dismissed: [] };
  return {
    calls,
    listReviews: async () => reviews,
    createReview: async (b) => {
      if (opts.createError) throw opts.createError;
      calls.created.push(b);
    },
    dismissReview: async (id, message) => {
      if (opts.dismissError) throw opts.dismissError;
      calls.dismissed.push({ id, message });
    },
  };
}

const base = { repo: REPO, repoHead: REPO, headSha: SHA1, status: 'valid', reason: 'ok' };

describe('postAttestationReview', () => {
  it('does not approve a qualified (soft-fail or spot-check) verification', async () => {
    for (const reason of ['ok (soft-fail: transcript-leaves.jsonl missing)', 'ok (spot-check)']) {
      const api = fakeApi();
      const r = await postAttestationReview({ ...base, reason, api });
      assert.equal(r.action, 'skipped');
      assert.equal(api.calls.created.length, 0);
    }
  });

  it('approves on a verified envelope', async () => {
    const api = fakeApi();
    const r = await postAttestationReview({ ...base, api });
    assert.equal(r.action, 'approved');
    assert.equal(api.calls.created.length, 1);
    assert.equal(api.calls.created[0].event, 'APPROVE');
    assert.equal(api.calls.created[0].commit_id, SHA1);
    assert.ok(api.calls.created[0].body.includes(REVIEW_MARKER));
  });

  it('does not review when verification failed', async () => {
    for (const status of ['invalid', '', undefined]) {
      const api = fakeApi();
      const r = await postAttestationReview({ ...base, api, status });
      assert.equal(r.action, 'skipped');
      assert.equal(api.calls.created.length, 0);
    }
  });

  it('does not review fork PRs', async () => {
    const api = fakeApi();
    const r = await postAttestationReview({ ...base, api, repoHead: 'evil/repo' });
    assert.equal(r.action, 'skipped');
    assert.equal(api.calls.created.length, 0);
    const r2 = await postAttestationReview({ ...base, api, repoHead: undefined });
    assert.equal(r2.action, 'skipped');
  });

  it('is idempotent per head SHA', async () => {
    const api = fakeApi([
      { id: 1, state: 'APPROVED', commit_id: SHA1, body: `${REVIEW_MARKER} x` },
    ]);
    const r = await postAttestationReview({ ...base, api });
    assert.equal(r.action, 'skipped');
    assert.equal(api.calls.created.length, 0);
    assert.equal(api.calls.dismissed.length, 0);
  });

  it('dismisses stale own approvals and posts a new one', async () => {
    const api = fakeApi([
      { id: 1, state: 'APPROVED', commit_id: SHA2, body: `${REVIEW_MARKER} old` },
      { id: 2, state: 'APPROVED', commit_id: SHA2, body: 'human approval' },
      { id: 3, state: 'DISMISSED', commit_id: SHA2, body: `${REVIEW_MARKER} older` },
    ]);
    const r = await postAttestationReview({ ...base, api });
    assert.equal(r.action, 'approved');
    assert.equal(r.dismissed, 1);
    assert.deepEqual(
      api.calls.dismissed.map((d) => d.id),
      [1],
    );
    assert.equal(api.calls.created.length, 1);
  });

  it('403 on create names the repository setting', async () => {
    const api = fakeApi([], { createError: new ApiError('forbidden', 403) });
    await assert.rejects(
      postAttestationReview({ ...base, api }),
      (e) => e.message.includes(SETTING_NAME) && e.message.includes('403'),
    );
  });

  it('tolerates 422 when dismissing an already dismissed review', async () => {
    const api = fakeApi([{ id: 1, state: 'APPROVED', commit_id: SHA2, body: REVIEW_MARKER }], {
      dismissError: new ApiError('gone', 422),
    });
    const r = await postAttestationReview({ ...base, api });
    assert.equal(r.action, 'approved');
  });

  it('body links the envelope and transcripts', () => {
    const body = buildReviewBody({ repo: REPO, headSha: SHA1, reason: 'good' });
    assert.ok(body.includes('/.ai-sdlc/attestations'));
    assert.ok(body.includes('/.ai-sdlc/transcript-leaves'));
    assert.ok(body.includes('good'));
  });
});

describe('createFetchApi', () => {
  it('maps non-ok responses to ApiError with status', async () => {
    const api = createFetchApi({
      token: 't',
      repo: REPO,
      prNumber: 5,
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'nope' }),
    });
    await assert.rejects(api.createReview({}), (e) => e instanceof ApiError && e.status === 403);
  });

  it('posts to the PR reviews endpoint', async () => {
    const seen = [];
    const api = createFetchApi({
      token: 't',
      repo: REPO,
      prNumber: 5,
      fetchImpl: async (url, init) => {
        seen.push([init.method, url]);
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    await api.createReview({ event: 'APPROVE' });
    await api.dismissReview(9, 'm');
    assert.deepEqual(seen, [
      ['POST', 'https://api.github.com/repos/org/repo/pulls/5/reviews'],
      ['PUT', 'https://api.github.com/repos/org/repo/pulls/5/reviews/9/dismissals'],
    ]);
  });
});
