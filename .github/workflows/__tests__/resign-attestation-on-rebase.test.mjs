#!/usr/bin/env node
/**
 * Hermetic test for the `resign-attestation-on-rebase.yml` detection heuristic.
 * (AISDLC-397 AC-5)
 *
 * Tests the core detection logic in isolation using fixture envelope SHAs and
 * mock git tree state — no GitHub API calls, no signing key, no pnpm install.
 *
 * Run: node .github/workflows/resign-attestation-on-rebase.test.mjs
 *
 * Expected output: "All N tests passed." (exit 0)
 * On failure:      descriptive error + exit 1
 */

import { strict as assert } from 'node:assert';

// ── Heuristic under test ─────────────────────────────────────────────────────
//
// The workflow's `detect` step decides `needs_resign=true` when:
//   1. An attestation envelope existed for the BEFORE SHA (pre-rebase).
//   2. No matching envelope exists for the AFTER SHA (post-rebase).
//
// We model the git tree state as two Maps: `beforeTree` and `afterTree`,
// each mapping a file path to its existence (true/false). This lets us test
// every combination without spawning a real git process.

/**
 * @param {string} beforeSha - SHA before the rebase (github.event.before)
 * @param {string} afterSha  - SHA after the rebase (github.event.after)
 * @param {Set<string>} beforeEnvelopes - envelope paths that existed BEFORE
 * @param {Set<string>} afterEnvelopes  - envelope paths that exist AFTER
 * @returns {{ needsResign: boolean, reason: string }}
 */
function detectHeuristic(beforeSha, afterSha, beforeEnvelopes, afterEnvelopes) {
  const beforeEnvV5 = `.ai-sdlc/attestations/${beforeSha}.dsse.json`;
  const beforeEnvV6 = `.ai-sdlc/attestations/${beforeSha}.v6.dsse.json`;
  const afterEnvV5 = `.ai-sdlc/attestations/${afterSha}.dsse.json`;
  const afterEnvV6 = `.ai-sdlc/attestations/${afterSha}.v6.dsse.json`;

  const beforeHadEnv = beforeEnvelopes.has(beforeEnvV5) || beforeEnvelopes.has(beforeEnvV6);
  const afterHasEnv = afterEnvelopes.has(afterEnvV5) || afterEnvelopes.has(afterEnvV6);

  if (beforeHadEnv && !afterHasEnv) {
    return {
      needsResign: true,
      reason: 'update-branch rebase detected: before had envelope, after does not',
    };
  }
  if (!beforeHadEnv) {
    return {
      needsResign: false,
      reason: 'before SHA had no envelope — not a rebase of a signed PR',
    };
  }
  if (afterHasEnv) {
    return {
      needsResign: false,
      reason: 'after SHA already has envelope — operator already re-signed',
    };
  }
  return { needsResign: false, reason: 'should not reach here' };
}

// ── Fixture SHAs (40-char lowercase hex, realistic but fake) ─────────────────
const BEFORE_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const AFTER_SHA = 'ffff6666aaaa7777bbbb8888cccc9999dddd0000';

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

console.log('resign-attestation detection heuristic tests (AISDLC-397 AC-5)\n');

// ── TC-1: Classic update-branch rebase (v5 envelope) ────────────────────────
// Before: v5 envelope for BEFORE_SHA exists.
// After:  no envelope for AFTER_SHA.
// Expected: needs_resign=true.
test('TC-1: update-branch rebase with v5 before-envelope → needs_resign=true', () => {
  const before = new Set([`.ai-sdlc/attestations/${BEFORE_SHA}.dsse.json`]);
  const after = new Set();
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, true, `expected needs_resign=true but got false (reason: ${reason})`);
});

// ── TC-2: Classic update-branch rebase (v6 envelope) ────────────────────────
// Before: v6 envelope for BEFORE_SHA exists.
// After:  no envelope for AFTER_SHA.
// Expected: needs_resign=true.
test('TC-2: update-branch rebase with v6 before-envelope → needs_resign=true', () => {
  const before = new Set([`.ai-sdlc/attestations/${BEFORE_SHA}.v6.dsse.json`]);
  const after = new Set();
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, true, `expected needs_resign=true but got false (reason: ${reason})`);
});

// ── TC-3: Operator pushed new code (before had no envelope) ─────────────────
// Before: no envelope (dev commit before sign step).
// After:  no envelope (still hasn't been signed).
// Expected: needs_resign=false (the before SHA was not a signed state).
test('TC-3: operator pushed new unsigned code → needs_resign=false', () => {
  const before = new Set();
  const after = new Set();
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, false, `expected needs_resign=false but got true (reason: ${reason})`);
});

// ── TC-4: After SHA already has an envelope (operator already re-signed) ─────
// Before: v5 envelope.
// After:  v5 envelope for the NEW SHA already present (operator signed locally).
// Expected: needs_resign=false.
test('TC-4: operator already re-signed after rebase → needs_resign=false', () => {
  const before = new Set([`.ai-sdlc/attestations/${BEFORE_SHA}.dsse.json`]);
  const after = new Set([`.ai-sdlc/attestations/${AFTER_SHA}.dsse.json`]);
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, false, `expected needs_resign=false but got true (reason: ${reason})`);
});

// ── TC-5: After SHA already has a v6 envelope ────────────────────────────────
// Edge case: v6 was active at sign time; after the rebase the operator signed
// a v6 envelope locally. Expected: needs_resign=false.
test('TC-5: operator re-signed v6 envelope after rebase → needs_resign=false', () => {
  const before = new Set([`.ai-sdlc/attestations/${BEFORE_SHA}.v6.dsse.json`]);
  const after = new Set([`.ai-sdlc/attestations/${AFTER_SHA}.v6.dsse.json`]);
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, false, `expected needs_resign=false but got true (reason: ${reason})`);
});

// ── TC-6: Mixed — before had v5, after has v6 ────────────────────────────────
// Unusual case where operator switched to v6 while re-signing after rebase.
// Expected: needs_resign=false (any after envelope satisfies the condition).
test('TC-6: before v5 → after v6 (schema upgrade during re-sign) → needs_resign=false', () => {
  const before = new Set([`.ai-sdlc/attestations/${BEFORE_SHA}.dsse.json`]);
  const after = new Set([`.ai-sdlc/attestations/${AFTER_SHA}.v6.dsse.json`]);
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, false, `expected needs_resign=false but got true (reason: ${reason})`);
});

// ── TC-7: Multiple sibling envelopes in before tree ──────────────────────────
// The attestations dir has envelopes for multiple historical SHAs.
// The BEFORE_SHA has one; AFTER_SHA does not.
// Expected: needs_resign=true (we only care about the BEFORE and AFTER SHAs).
test('TC-7: multiple historical envelopes in tree, before has one, after does not → needs_resign=true', () => {
  const otherSha = '1234567890abcdef1234567890abcdef12345678';
  const before = new Set([
    `.ai-sdlc/attestations/${otherSha}.dsse.json`,
    `.ai-sdlc/attestations/${BEFORE_SHA}.dsse.json`,
  ]);
  const after = new Set([
    `.ai-sdlc/attestations/${otherSha}.dsse.json`,
    // BEFORE_SHA envelope still present from old checkout, but no AFTER_SHA envelope.
    `.ai-sdlc/attestations/${BEFORE_SHA}.dsse.json`,
  ]);
  const { needsResign, reason } = detectHeuristic(BEFORE_SHA, AFTER_SHA, before, after);
  assert.equal(needsResign, true, `expected needs_resign=true but got false (reason: ${reason})`);
});

// ── TC-8: before === after (force-push that didn't change HEAD) ───────────────
// GitHub can sometimes send a synchronize event where before == after (e.g.
// a force-push that landed the same tree). In this case the before SHA had
// an envelope, and the SAME SHA is now HEAD — so after trivially has the
// envelope too. Expected: needs_resign=false.
test('TC-8: before == after (no-op force-push) → needs_resign=false', () => {
  const sha = BEFORE_SHA;
  const before = new Set([`.ai-sdlc/attestations/${sha}.dsse.json`]);
  // The after tree also contains the same envelope (same SHA = same tree).
  const after = new Set([`.ai-sdlc/attestations/${sha}.dsse.json`]);
  const { needsResign } = detectHeuristic(sha, sha, before, after);
  assert.equal(needsResign, false, 'expected needs_resign=false for no-op force-push');
});

// ── TC-9: Chore commit loop guard (integration perspective) ──────────────────
// This tests the loop-guard logic: if the HEAD commit subject starts with
// "chore: re-sign attestation", the workflow short-circuits before reaching
// the detect step. We model this as a separate guard function.
function choreLoopGuard(commitSubject) {
  return /^chore: re-sign attestation/.test(commitSubject);
}

test('TC-9a: chore commit subject → loop guard fires → skip=true', () => {
  assert.equal(
    choreLoopGuard(
      'chore: re-sign attestation for AISDLC-373 after merge-queue rebase (AISDLC-397)',
    ),
    true,
  );
});

test('TC-9b: normal commit subject → loop guard does not fire → skip=false', () => {
  assert.equal(choreLoopGuard('feat(ci): add resign workflow (AISDLC-397)'), false);
  assert.equal(choreLoopGuard('chore: sign attestation for AISDLC-373 (AISDLC-74)'), false);
  assert.equal(choreLoopGuard('fix: something unrelated'), false);
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.error(`${failed} test(s) FAILED, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`All ${passed} tests passed.`);
  process.exit(0);
}
