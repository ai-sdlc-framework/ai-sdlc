/**
 * Tests for `scripts/post-attestation-comment.mjs` — the friendly fallback
 * comment posted when CI's `verify-attestation` workflow can't accept the
 * attestation (AISDLC-74, AC #8).
 *
 * Verifies the marker shape (idempotency hinge), the body content matches
 * the design spec, and the marker is HTML-comment-style (invisible to humans
 * but stable for the next run to detect).
 *
 * Run with: node --test scripts/post-attestation-comment.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, buildBody, main } from './post-attestation-comment.mjs';

describe('MARKER (idempotency hinge)', () => {
  it('is an HTML comment so humans never see it', () => {
    assert.match(MARKER, /^<!--/);
    assert.match(MARKER, /-->$/);
  });

  it('mentions ai-sdlc and attestation so it is greppable across the repo', () => {
    assert.match(MARKER, /ai-sdlc/);
    assert.match(MARKER, /attestation/);
  });

  it('is stable across builds (constant — no timestamp/run-id baked in)', () => {
    assert.equal(MARKER, '<!-- ai-sdlc:attestation-fallback-comment -->');
  });
});

describe('buildBody', () => {
  it('embeds the marker as the first line so the next run can find it', () => {
    const body = buildBody('missing', 'abcdef0123456789');
    assert.ok(body.startsWith(MARKER), 'marker should be the first line');
  });

  it('explains how to opt into local /ai-sdlc execute', () => {
    const body = buildBody('missing', '');
    assert.match(body, /\/ai-sdlc init-signing-key/);
    assert.match(body, /\/ai-sdlc execute/);
    assert.match(body, /trusted-reviewers\.yaml/);
  });

  it('lists the most common failure causes (force-push, policy edit, missing key)', () => {
    const body = buildBody('invalid (diffHash mismatch)', 'sha');
    assert.match(body, /force-push/i);
    assert.match(body, /review-policy\.md/);
    assert.match(body, /trusted-reviewers/);
  });

  it('includes the reason verbatim so the contributor can grep for it', () => {
    const body = buildBody('invalid (signature did not match any trusted reviewer pubkey)', '');
    assert.match(body, /invalid \(signature did not match any trusted reviewer pubkey\)/);
  });

  it('includes the head SHA when provided', () => {
    const body = buildBody('missing', 'deadbeef');
    assert.match(body, /deadbeef/);
  });

  it('omits the head SHA line cleanly when not provided', () => {
    const body = buildBody('missing', '');
    assert.ok(!body.includes('Head SHA:'), 'should not render an empty SHA line');
  });

  it('points at CLAUDE.md → "Review attestations" for full bootstrap docs', () => {
    const body = buildBody('missing', '');
    assert.match(body, /CLAUDE\.md/);
    assert.match(body, /Review attestations/);
  });
});

// ─── main() integration with mocked fetch ─────────────────────────
//
// Verifies the idempotent-skip branch (existing comment found → no POST)
// AND the post branch (no existing → POST executed). Mocks `globalThis.fetch`
// so we don't hit the real GitHub API.

describe('main() (mocked fetch)', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build a fake fetch that records calls and returns programmable responses. */
  function fakeFetch(handlers) {
    return async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body });
      const handler = handlers.shift();
      if (!handler) throw new Error(`unexpected fetch to ${url}`);
      return {
        ok: handler.ok,
        status: handler.status ?? 200,
        text: async () => handler.text ?? '',
        json: async () => handler.json,
      };
    };
  }

  const env = {
    GH_TOKEN: 'fake-token',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
    ATTESTATION_REASON: 'invalid (diffHash mismatch)',
    PR_HEAD_SHA: 'deadbeef',
  };

  it('skips POST when an existing comment already carries the marker (idempotent path)', async () => {
    let stdout = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => {
      stdout += s;
      return true;
    };
    try {
      globalThis.fetch = fakeFetch([
        // GET existing comments — return one that already has our marker.
        { ok: true, json: [{ id: 12345, body: `${MARKER}\nprevious comment\n` }] },
      ]);
      await main(env);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(calls.length, 1, 'should only GET, never POST');
    assert.equal(calls[0].method, 'GET');
    assert.match(stdout, /Idempotent skip.*12345/);
  });

  it('POSTs a new comment when none with the marker exists', async () => {
    let stdout = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => {
      stdout += s;
      return true;
    };
    try {
      globalThis.fetch = fakeFetch([
        // GET — no existing comments with our marker.
        { ok: true, json: [{ id: 99, body: 'an unrelated comment' }] },
        // POST — comment created.
        { ok: true, json: { id: 67890 } },
      ]);
      await main(env);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(calls.length, 2, 'should GET then POST');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'POST');
    const posted = JSON.parse(calls[1].body);
    assert.match(posted.body, /diffHash mismatch/);
    assert.match(posted.body, /deadbeef/);
    assert.ok(posted.body.startsWith(MARKER), 'POST body must include marker');
    assert.match(stdout, /Posted attestation-fallback comment id 67890/);
  });

  it('throws on a 5xx GET (so the workflow surfaces the error rather than silently skipping)', async () => {
    globalThis.fetch = fakeFetch([{ ok: false, status: 503, text: 'service unavailable' }]);
    await assert.rejects(() => main(env), /GET comments failed: 503/);
  });
});
