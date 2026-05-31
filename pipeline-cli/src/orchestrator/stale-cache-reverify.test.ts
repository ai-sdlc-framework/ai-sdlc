/**
 * Tests for the stale-cache reverify state logic (AISDLC-449).
 *
 * Covers:
 *   - counter increment on a no-change tick
 *   - counter reset when the blocked-PR fingerprint changes
 *   - counter reset when a dispatch happens
 *   - `shouldReverify` firing EXACTLY at K (default 2) and staying on
 *   - K configurability (default 2 + env override + explicit override)
 *   - `classifyReverifyResult` new-signal vs same-blocker
 *   - persistence round-trip + corrupt-file resilience
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CADENCE_K_GUIDANCE,
  classifyReverifyBatch,
  classifyReverifyResult,
  DEFAULT_STALE_CACHE_REVERIFY_K,
  fingerprintBlockedPrs,
  initialPassiveTickState,
  passiveStatePath,
  readPassiveTickState,
  resolveReverifyK,
  STALE_CACHE_REVERIFY_K_ENV,
  updatePassiveTickState,
  writePassiveTickState,
  type BlockedPrSignature,
  type PassiveTickState,
} from './stale-cache-reverify.js';

const PR_A: BlockedPrSignature = {
  prNumber: '4321',
  checkSignature: 'attestation:failure:v6-envelope',
};
const PR_A_NEW: BlockedPrSignature = {
  prNumber: '4321',
  checkSignature: 'attestation:failure:merkle-root-mismatch',
};
const PR_B: BlockedPrSignature = { prNumber: '4400', checkSignature: 'pr-ready:pending' };

describe('resolveReverifyK', () => {
  it('defaults to 2', () => {
    expect(resolveReverifyK({ env: {} })).toBe(DEFAULT_STALE_CACHE_REVERIFY_K);
    expect(DEFAULT_STALE_CACHE_REVERIFY_K).toBe(2);
  });

  it('honors the env override', () => {
    expect(resolveReverifyK({ env: { [STALE_CACHE_REVERIFY_K_ENV]: '3' } })).toBe(3);
  });

  it('honors an explicit override above the env var', () => {
    expect(resolveReverifyK({ override: 5, env: { [STALE_CACHE_REVERIFY_K_ENV]: '3' } })).toBe(5);
  });

  it('falls through a bad env value to the default', () => {
    expect(resolveReverifyK({ env: { [STALE_CACHE_REVERIFY_K_ENV]: 'not-a-number' } })).toBe(2);
    expect(resolveReverifyK({ env: { [STALE_CACHE_REVERIFY_K_ENV]: '0' } })).toBe(2);
    expect(resolveReverifyK({ env: { [STALE_CACHE_REVERIFY_K_ENV]: '-4' } })).toBe(2);
  });

  it('floors a fractional explicit override', () => {
    expect(resolveReverifyK({ override: 3.9, env: {} })).toBe(3);
  });

  it('exposes cadence→K guidance with default at 1h cadence', () => {
    const oneHour = CADENCE_K_GUIDANCE.find((r) => r.cadence === '1h');
    expect(oneHour?.k).toBe(2);
    expect(oneHour?.graceWindow).toBe('2h');
  });
});

describe('fingerprintBlockedPrs', () => {
  it('is order-insensitive', () => {
    expect(fingerprintBlockedPrs([PR_A, PR_B])).toBe(fingerprintBlockedPrs([PR_B, PR_A]));
  });

  it('changes when a PR check signature changes', () => {
    expect(fingerprintBlockedPrs([PR_A])).not.toBe(fingerprintBlockedPrs([PR_A_NEW]));
  });

  it('changes when membership changes', () => {
    expect(fingerprintBlockedPrs([PR_A])).not.toBe(fingerprintBlockedPrs([PR_A, PR_B]));
  });

  it('is empty for an empty set', () => {
    expect(fingerprintBlockedPrs([])).toBe('');
  });
});

describe('updatePassiveTickState — increment / reset', () => {
  it('increments on a no-change tick (same blocked set, no dispatch)', () => {
    const prev = initialPassiveTickState();
    // First observation seeds the fingerprint; counter stays 0 because the
    // prior fingerprint was empty (membership changed).
    const t1 = updatePassiveTickState(prev, { blockedPrs: [PR_A], dispatchCount: 0 }, { env: {} });
    expect(t1.next.consecutiveNoChangeTicks).toBe(0);

    // Second observation: same blocked set, no dispatch → increment to 1.
    const t2 = updatePassiveTickState(
      t1.next,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    );
    expect(t2.next.consecutiveNoChangeTicks).toBe(1);
  });

  it('resets when the blocked-PR fingerprint changes', () => {
    let state = initialPassiveTickState();
    state = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    ).next;
    state = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    ).next;
    expect(state.consecutiveNoChangeTicks).toBe(1);

    // The blocker's reason changed (PR_A → PR_A_NEW) → reset.
    const moved = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A_NEW], dispatchCount: 0 },
      { env: {} },
    );
    expect(moved.next.consecutiveNoChangeTicks).toBe(0);
  });

  it('resets when a dispatch happens even if the blocked set is unchanged', () => {
    let state = initialPassiveTickState();
    state = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    ).next;
    state = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    ).next;
    expect(state.consecutiveNoChangeTicks).toBe(1);

    const dispatched = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 1 },
      { env: {} },
    );
    expect(dispatched.next.consecutiveNoChangeTicks).toBe(0);
    expect(dispatched.shouldReverify).toBe(false);
  });

  it('does not accumulate when nothing is blocked', () => {
    let state = initialPassiveTickState();
    state = updatePassiveTickState(state, { blockedPrs: [], dispatchCount: 0 }, { env: {} }).next;
    const t2 = updatePassiveTickState(state, { blockedPrs: [], dispatchCount: 0 }, { env: {} });
    expect(t2.next.consecutiveNoChangeTicks).toBe(0);
    expect(t2.shouldReverify).toBe(false);
  });
});

describe('updatePassiveTickState — shouldReverify fires at K', () => {
  it('fires EXACTLY at K=2 (the 2026-05-26 incident scenario)', () => {
    // Tick N: blocked on the v6 envelope, first sighting → seeds fingerprint.
    let state = initialPassiveTickState();
    const tN = updatePassiveTickState(state, { blockedPrs: [PR_A], dispatchCount: 0 }, { env: {} });
    expect(tN.shouldReverify).toBe(false);
    expect(tN.next.consecutiveNoChangeTicks).toBe(0);
    state = tN.next;

    // Tick N+1: still blocked, no dispatch → counter 1, below K.
    const tN1 = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    );
    expect(tN1.shouldReverify).toBe(false);
    expect(tN1.next.consecutiveNoChangeTicks).toBe(1);
    state = tN1.next;

    // Tick N+2: still blocked → counter 2 == K → reverify fires.
    const tN2 = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    );
    expect(tN2.next.consecutiveNoChangeTicks).toBe(2);
    expect(tN2.shouldReverify).toBe(true);
    expect(tN2.k).toBe(2);
  });

  it('keeps firing on subsequent no-change ticks (no silent rot)', () => {
    let state = initialPassiveTickState();
    for (let i = 0; i < 3; i++) {
      state = updatePassiveTickState(
        state,
        { blockedPrs: [PR_A], dispatchCount: 0 },
        { env: {} },
      ).next;
    }
    // After 3 no-change observations past the seed the counter is >= K.
    const again = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { env: {} },
    );
    expect(again.shouldReverify).toBe(true);
  });

  it('respects an explicit K override (K=3 fires one tick later)', () => {
    let state = initialPassiveTickState();
    const seed = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { k: 3, env: {} },
    );
    state = seed.next;
    const a = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { k: 3, env: {} },
    );
    expect(a.shouldReverify).toBe(false); // counter 1
    state = a.next;
    const b = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { k: 3, env: {} },
    );
    expect(b.shouldReverify).toBe(false); // counter 2
    state = b.next;
    const c = updatePassiveTickState(
      state,
      { blockedPrs: [PR_A], dispatchCount: 0 },
      { k: 3, env: {} },
    );
    expect(c.shouldReverify).toBe(true); // counter 3 == K
  });

  it('respects the env K override', () => {
    const env = { [STALE_CACHE_REVERIFY_K_ENV]: '1' };
    let state = initialPassiveTickState();
    const seed = updatePassiveTickState(state, { blockedPrs: [PR_A], dispatchCount: 0 }, { env });
    state = seed.next;
    // With K=1, the first no-change tick after the seed fires.
    const t = updatePassiveTickState(state, { blockedPrs: [PR_A], dispatchCount: 0 }, { env });
    expect(t.next.consecutiveNoChangeTicks).toBe(1);
    expect(t.shouldReverify).toBe(true);
  });
});

describe('classifyReverifyResult', () => {
  it('returns same-blocker when signatures match (AC-4)', () => {
    const r = classifyReverifyResult(PR_A.checkSignature, PR_A.checkSignature, '4321');
    expect(r.kind).toBe('same-blocker');
    expect(r.prNumber).toBe('4321');
  });

  it('returns new-signal when the failing check changed reason (AC-3)', () => {
    const r = classifyReverifyResult(PR_A.checkSignature, PR_A_NEW.checkSignature, '4321');
    expect(r.kind).toBe('new-signal');
  });

  it('ignores whitespace-only differences', () => {
    const r = classifyReverifyResult('  attestation:failure  ', 'attestation:failure');
    expect(r.kind).toBe('same-blocker');
  });
});

describe('classifyReverifyBatch', () => {
  it('classifies each cached PR against the fresh map', () => {
    const out = classifyReverifyBatch([PR_A, PR_B], {
      '4321': PR_A_NEW.checkSignature, // changed → new-signal
      '4400': PR_B.checkSignature, // unchanged → same-blocker
    });
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.prNumber === '4321')?.kind).toBe('new-signal');
    expect(out.find((c) => c.prNumber === '4400')?.kind).toBe('same-blocker');
  });

  it('skips PRs absent from the fresh map (re-fetch failed)', () => {
    const out = classifyReverifyBatch([PR_A, PR_B], { '4321': PR_A.checkSignature });
    expect(out).toHaveLength(1);
    expect(out[0]?.prNumber).toBe('4321');
  });
});

describe('persistence round-trip', () => {
  let boardDir: string;

  beforeEach(() => {
    boardDir = mkdtempSync(path.join(tmpdir(), 'reverify-state-'));
  });

  afterEach(() => {
    rmSync(boardDir, { recursive: true, force: true });
  });

  it('reads back what it writes', () => {
    const state: PassiveTickState = {
      schemaVersion: 'v1',
      consecutiveNoChangeTicks: 2,
      lastBlockedFingerprint: fingerprintBlockedPrs([PR_A]),
      lastDispatchCount: 0,
      lastBlockedPrs: [PR_A],
      updatedAt: '2026-05-27T00:00:00.000Z',
    };
    writePassiveTickState(boardDir, state);
    const read = readPassiveTickState(boardDir);
    expect(read).toEqual(state);
  });

  it('returns the zero-state when the file is missing', () => {
    const read = readPassiveTickState(boardDir);
    expect(read.consecutiveNoChangeTicks).toBe(0);
    expect(read.lastBlockedPrs).toEqual([]);
  });

  it('returns the zero-state when the file is corrupt', () => {
    writeFileSync(passiveStatePath(boardDir), '{not json', 'utf8');
    const read = readPassiveTickState(boardDir);
    expect(read.consecutiveNoChangeTicks).toBe(0);
  });
});
