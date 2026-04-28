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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, buildBody } from './post-attestation-comment.mjs';

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
