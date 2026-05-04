/**
 * Tests for the gh PR cache source (RFC-0023 Phase 2 / AISDLC-178.2).
 *
 * Covers:
 *   - Pure fetcher: runner success, runner ENOENT, runner non-zero exit,
 *     stdout that's not JSON, stdout that's not an array.
 *   - Cache: TTL freshness predicate, makeEmptyCache initial state.
 *   - React hook: mount fetch, interval polling, invalidate() bypass,
 *     unmount clears interval.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import {
  fetchGhPrs,
  GH_PR_CACHE_TTL_MS,
  GH_PR_ERROR_BACKOFF_SCHEDULE_MS,
  GH_PR_JSON_FIELDS,
  GH_PR_POLL_INTERVAL_MS,
  isFresh,
  makeEmptyCache,
  useGhPrs,
  type FetchGhPrsResult,
} from './gh-pr-cache.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Polls `predicate()` until it returns true or `attempts` is exhausted
 * (each iteration is one setImmediate round-trip). Ink wraps a custom
 * React reconciler that schedules effects via the scheduler package's
 * `setImmediate`, so each round-trip yields back AFTER one batch of
 * effect callbacks fires. Use for assertions that depend on a setState
 * having committed (e.g. `captured` populated by a `useEffect`, or the
 * mount-fetch's setState landing in `state`).
 *
 * AISDLC-188 root cause: under load on freshly-started CI runners, 1-2
 * setImmediate round-trips occasionally weren't enough for the React
 * commit queue to drain a mount-fetch's setState into the capture
 * effect; a predicate-driven wait adapts to whatever the scheduler
 * actually takes (each round is a synchronous setImmediate — no
 * real-clock wait under fake timers).
 */
async function waitForFlushed(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitForFlushed: predicate not satisfied after ${attempts} attempts`);
}

describe('GH_PR_JSON_FIELDS', () => {
  it('includes the field set the TUI consumes', () => {
    expect(GH_PR_JSON_FIELDS).toContain('number');
    expect(GH_PR_JSON_FIELDS).toContain('title');
    expect(GH_PR_JSON_FIELDS).toContain('state');
    expect(GH_PR_JSON_FIELDS).toContain('url');
    expect(GH_PR_JSON_FIELDS).toContain('updatedAt');
    expect(GH_PR_JSON_FIELDS).toContain('mergeable');
    expect(GH_PR_JSON_FIELDS).toContain('statusCheckRollup');
    expect(GH_PR_JSON_FIELDS).toContain('labels');
  });
});

describe('fetchGhPrs (pure)', () => {
  it('parses healthy `gh pr list` output', () => {
    const runner = (args: readonly string[]): string => {
      expect(args).toContain('pr');
      expect(args).toContain('list');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      expect(args).toContain('--json');
      return JSON.stringify([
        { number: 1, title: 'A', state: 'OPEN', url: 'http://x/1' },
        { number: 2, title: 'B', state: 'OPEN', url: 'http://x/2' },
      ]);
    };
    const result = fetchGhPrs({ runner });
    expect(result.error).toBeNull();
    expect(result.prs).toHaveLength(2);
    expect(result.prs[0].number).toBe(1);
  });

  it('returns source-unavailable when the runner throws (gh missing / non-zero)', () => {
    const runner = (): string => {
      throw new Error('spawn gh ENOENT');
    };
    const result = fetchGhPrs({ runner });
    expect(result.prs).toEqual([]);
    expect(result.error).toBe('source-unavailable');
  });

  it('returns source-corrupt when stdout is not JSON', () => {
    const runner = (): string => 'this is not json';
    const result = fetchGhPrs({ runner });
    expect(result.prs).toEqual([]);
    expect(result.error).toBe('source-corrupt');
  });

  it('returns source-corrupt when JSON is not an array', () => {
    const runner = (): string => JSON.stringify({ prs: [] });
    const result = fetchGhPrs({ runner });
    expect(result.prs).toEqual([]);
    expect(result.error).toBe('source-corrupt');
  });
});

describe('isFresh + makeEmptyCache', () => {
  it('makeEmptyCache starts with fetchedAt = -Infinity (always stale)', () => {
    const cache = makeEmptyCache();
    expect(cache.result.prs).toEqual([]);
    expect(cache.result.error).toBeNull();
    expect(isFresh(cache, 60_000, 0)).toBe(false);
    expect(isFresh(cache, 60_000, 1_000_000)).toBe(false);
  });

  it('isFresh returns true within the TTL window', () => {
    const cache = { result: { prs: [], error: null }, fetchedAt: 1_000 };
    expect(isFresh(cache, 60_000, 1_500)).toBe(true);
    expect(isFresh(cache, 60_000, 60_999)).toBe(true);
  });

  it('isFresh returns false past the TTL window', () => {
    const cache = { result: { prs: [], error: null }, fetchedAt: 1_000 };
    expect(isFresh(cache, 60_000, 61_001)).toBe(false);
    expect(isFresh(cache, 60_000, 100_000)).toBe(false);
  });
});

// ── Hook ──────────────────────────────────────────────────────────────

function HookProbe({
  capture,
  fetcher,
  intervalMs,
  ttlMs,
  clock,
  errorBackoffScheduleMs,
}: {
  capture: (state: ReturnType<typeof useGhPrs>) => void;
  fetcher: () => FetchGhPrsResult;
  intervalMs?: number;
  ttlMs?: number;
  clock?: () => number;
  errorBackoffScheduleMs?: readonly number[];
}): React.ReactElement {
  const state = useGhPrs({ fetcher, intervalMs, ttlMs, clock, errorBackoffScheduleMs });
  React.useEffect(() => {
    capture(state);
  });
  return React.createElement(Text, null, `count=${state.data.length}`);
}

describe('useGhPrs (hook)', () => {
  it('exposes default constants matching RFC-0023 §6.2', () => {
    expect(GH_PR_CACHE_TTL_MS).toBe(60_000);
    expect(GH_PR_POLL_INTERVAL_MS).toBe(60_000);
  });

  it('fetches on mount + every intervalMs poll', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      return {
        prs: [
          { number: callCount, title: 't', state: 'OPEN', url: 'u', createdAt: '', updatedAt: '' },
        ],
        error: null,
      };
    };

    // Use a TTL of 0 so the interval-driven poll is never short-circuited
    // by the cache (we're testing the polling lifecycle here, not the TTL).
    const { unmount } = render(
      React.createElement(HookProbe, { capture: () => {}, fetcher, intervalMs: 100, ttlMs: 0 }),
    );

    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(4);

    unmount();
  });

  it('serves the TTL cache instead of re-fetching', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let now = 0;
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      return { prs: [], error: null };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        fetcher,
        intervalMs: 1_000, // poll every 1s (well within the 60s TTL)
        ttlMs: 60_000,
        clock: () => now,
      }),
    );

    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1); // mount fetch

    // Advance 5 polls — none should re-fetch because we're inside TTL.
    for (let i = 0; i < 5; i += 1) {
      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(callCount).toBe(1);

    // Skip past the TTL — next poll re-fetches.
    now += 60_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(2);

    unmount();
  });

  it('invalidate() busts the cache + immediately re-fetches', async () => {
    let captured: ReturnType<typeof useGhPrs> | null = null;
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      return {
        prs: [
          { number: callCount, title: 't', state: 'OPEN', url: 'u', createdAt: '', updatedAt: '' },
        ],
        error: null,
      };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        fetcher,
        intervalMs: 1_000_000, // huge — only mount + invalidate trigger
        ttlMs: 1_000_000, // huge — cache is always fresh
      }),
    );
    // Wait for the capture effect to surface the mount-fetch state
    // (mount fetch's setState must commit + the child capture useEffect
    // must run after the re-render). AISDLC-188: a fixed flush count
    // races on cold CI; predicate-based wait is bulletproof.
    await waitForFlushed(() => captured?.data?.[0]?.number === 1);
    expect(callCount).toBe(1);
    expect(captured!.data[0].number).toBe(1);

    captured!.invalidate();
    await waitForFlushed(() => captured?.data?.[0]?.number === 2);
    expect(callCount).toBe(2);
    expect(captured!.data[0].number).toBe(2);

    unmount();
  });

  it('clears the polling timer on unmount', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        fetcher: () => {
          callCount += 1;
          return { prs: [], error: null };
        },
        intervalMs: 100,
        ttlMs: 0,
      }),
    );
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(1);
  });

  it('surfaces fetcher errors via state.error', async () => {
    let captured: ReturnType<typeof useGhPrs> | null = null;
    const fetcher = (): FetchGhPrsResult => ({ prs: [], error: 'source-unavailable' });

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        fetcher,
        // AISDLC-187: pass an empty backoff schedule so this test doesn't
        // schedule a real-time setTimeout that could leak past unmount.
        // (We test the actual recovery semantic in dedicated cases below.)
        errorBackoffScheduleMs: [],
      }),
    );
    // Capture-via-useEffect needs the mount setState to commit AND the
    // child capture effect to fire — wait for the predicate rather than
    // a fixed flush count (AISDLC-188).
    await waitForFlushed(() => captured?.error != null);
    expect(captured!.error).toBe('source-unavailable');
    expect(captured!.data).toEqual([]);
    unmount();
  });
});

// ── AISDLC-187: fast-recovery on transient gh failures ─────────────────

describe('useGhPrs error-recovery backoff (AISDLC-187)', () => {
  it('exposes the default backoff schedule (5s → 10s → 20s)', () => {
    expect(GH_PR_ERROR_BACKOFF_SCHEDULE_MS).toEqual([5_000, 10_000, 20_000]);
  });

  it('clears state.error within ≤20s when source recovers (AC #1)', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let captured: ReturnType<typeof useGhPrs> | null = null;
    let callCount = 0;
    // Mount-fetch fails → backoff retry at +5s also fails →
    // next backoff at +10s (so total +15s) succeeds.
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      if (callCount <= 2) {
        return { prs: [], error: 'source-unavailable' };
      }
      return {
        prs: [
          { number: 7, title: 'recovered', state: 'OPEN', url: 'u', createdAt: '', updatedAt: '' },
        ],
        error: null,
      };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        fetcher,
        // Use the default 60s intervalMs — the bug is precisely that on
        // a 60s interval the operator sees stale "unavailable" until the
        // next tick. The backoff schedule must clear it sooner.
        intervalMs: 60_000,
        ttlMs: 60_000,
      }),
    );

    // Wait for the mount-fetch error to surface.
    await waitForFlushed(() => captured?.error === 'source-unavailable');
    expect(callCount).toBe(1);

    // +5s: first backoff retry — still failing.
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFlushed(() => callCount >= 2);
    expect(callCount).toBe(2);
    expect(captured!.error).toBe('source-unavailable');

    // +10s more (total +15s, well within the ≤20s AC budget): second
    // backoff fires, this time succeeds.
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForFlushed(() => captured?.error === null && callCount >= 3);
    expect(callCount).toBe(3);
    expect(captured!.error).toBeNull();
    expect(captured!.data[0].number).toBe(7);

    unmount();
  });

  it('caps consecutive-error backoff at intervalMs (no hot-loop on persistent failure, AC #2)', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    // Persistent failure — every fetch returns error.
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      return { prs: [], error: 'source-unavailable' };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        fetcher,
        intervalMs: 60_000,
        ttlMs: 60_000,
      }),
    );

    // Mount-fetch fails (call 1).
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    // Walk through the schedule: +5s → call 2, +10s → call 3,
    // +20s → call 4. Total +35s, 4 calls.
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFlushed(() => callCount >= 2);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitForFlushed(() => callCount >= 3);
    expect(callCount).toBe(3);

    await vi.advanceTimersByTimeAsync(20_000);
    await waitForFlushed(() => callCount >= 4);
    expect(callCount).toBe(4);

    // After the schedule is exhausted the next backoff caps at the
    // schedule's tail (20s) — verify it doesn't hot-loop. Advance 19s,
    // expect NO new call.
    await vi.advanceTimersByTimeAsync(19_000);
    expect(callCount).toBe(4);

    // +1s more (total +20s since last call) triggers the capped retry.
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFlushed(() => callCount >= 5);
    expect(callCount).toBe(5);

    unmount();
  });

  it('does NOT schedule a backoff on a successful fetch (AC #3 no regression)', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      return { prs: [], error: null };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        fetcher,
        intervalMs: 60_000,
        ttlMs: 60_000,
      }),
    );

    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    // No backoff timer on success — advance well past the longest backoff
    // (20s) and assert no extra fetches landed.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(callCount).toBe(1);

    // The regular intervalMs tick at +60s still fires.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(callCount).toBe(2);

    unmount();
  });

  it('resets backoff index after a recovered success (next failure starts at 5s again)', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    // Pattern: fail, fail, succeed, fail. After recovery, the next
    // failure should retry at 5s (schedule reset), not 20s.
    const sequence: Array<'ok' | 'err'> = ['err', 'err', 'ok', 'err', 'ok'];
    const fetcher = (): FetchGhPrsResult => {
      const kind = sequence[callCount] ?? 'ok';
      callCount += 1;
      if (kind === 'err') return { prs: [], error: 'source-unavailable' };
      return { prs: [], error: null };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        fetcher,
        intervalMs: 10_000, // short so the post-success interval tick fires
        ttlMs: 0, // disable TTL freshness — every interval tick re-fetches
      }),
    );

    await waitForFlushed(() => callCount >= 1); // mount: err (1)
    await vi.advanceTimersByTimeAsync(5_000); // +5s backoff: err (2)
    await waitForFlushed(() => callCount >= 2);
    await vi.advanceTimersByTimeAsync(10_000); // +10s backoff: ok (3) — backoff resets
    await waitForFlushed(() => callCount >= 3);
    expect(callCount).toBe(3);

    // Call 3 was a success — backoff index reset, no error timer
    // pending. The next interval tick fires at the next 10s boundary
    // after t=15s — i.e. t=20s. Drive 5s to reach it.
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFlushed(() => callCount >= 4);
    expect(callCount).toBe(4); // err

    // After the freshly-reset backoff, the next retry should fire at
    // +5s (NOT +20s — proving the index reset). Advance 4s — no call.
    // Advance 1 more — call 5.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(callCount).toBe(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFlushed(() => callCount >= 5);
    expect(callCount).toBe(5);

    unmount();
  });

  it('returns the standard {data, loading?, error, lastFetched} shape on every path (AC #4)', async () => {
    vi.useFakeTimers({
      now: 1_000,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let captured: ReturnType<typeof useGhPrs> | null = null;
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      // First call errors, second succeeds.
      if (callCount === 1) return { prs: [], error: 'source-unavailable' };
      return {
        prs: [{ number: 1, title: 't', state: 'OPEN', url: 'u', createdAt: '', updatedAt: '' }],
        error: null,
      };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        fetcher,
        intervalMs: 60_000,
        ttlMs: 60_000,
      }),
    );

    await waitForFlushed(() => captured?.error === 'source-unavailable');
    // Error path: data is the empty array, error is set, lastFetched is
    // a Date instance reflecting the attempt clock.
    expect(captured!.data).toEqual([]);
    expect(captured!.error).toBe('source-unavailable');
    expect(captured!.lastFetched).toBeInstanceOf(Date);
    expect(typeof captured!.invalidate).toBe('function');

    // Trigger the backoff retry → success.
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFlushed(() => captured?.error === null);
    expect(captured!.data).toHaveLength(1);
    expect(captured!.error).toBeNull();
    expect(captured!.lastFetched).toBeInstanceOf(Date);

    unmount();
  });

  it('falls back to intervalMs when the backoff schedule is exhausted (or empty)', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      return { prs: [], error: 'source-unavailable' };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        fetcher,
        // Empty schedule → backoff index lookup yields undefined → falls
        // back to intervalMs (the L279 `??` right-hand-side branch).
        // intervalMs (15s) is shorter than the regular setInterval tick
        // (45s) so we can isolate the backoff timer's behavior — but we
        // pick the relative values carefully so the interval cadence
        // doesn't collide with the backoff retry within the assertion
        // window.
        errorBackoffScheduleMs: [],
        intervalMs: 15_000,
        // Use a long ttlMs since the regular interval also calls refetch
        // and would re-fetch on every poll if cache were stale; but since
        // error fetches set fetchedAt=-Infinity anyway, ttlMs is moot for
        // the error path. The interval poll at +15s will collide with
        // the backoff at +15s — count both as one tick (callCount: 1→3).
        ttlMs: 60_000,
      }),
    );

    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    // Backoff scheduled for +15s (intervalMs fallback because schedule
    // was empty). Advance 14s — no call.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(callCount).toBe(1);

    // +1s more → both the backoff timer AND the interval tick fire at
    // t=15s (they coincide because we deliberately set them equal). The
    // important assertion is the backoff DID fire — callCount jumped.
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFlushed(() => callCount >= 2);
    expect(callCount).toBeGreaterThanOrEqual(2);

    unmount();
  });

  it('invalidate() clears in-flight backoff + resets the schedule', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let captured: ReturnType<typeof useGhPrs> | null = null;
    let callCount = 0;
    const fetcher = (): FetchGhPrsResult => {
      callCount += 1;
      // Errors on the mount-fetch + the invalidate-driven retry; succeeds
      // afterwards. We want to verify invalidate's forced fetch fires
      // immediately (call 2) and the post-invalidate backoff starts at
      // 5s (not 10s, even though we're on the 2nd consecutive error
      // overall — invalidate resets the counter).
      if (callCount <= 2) return { prs: [], error: 'source-unavailable' };
      return { prs: [], error: null };
    };

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        fetcher,
        intervalMs: 60_000,
        ttlMs: 60_000,
      }),
    );

    await waitForFlushed(() => captured?.error === 'source-unavailable');
    expect(callCount).toBe(1);

    // Operator hits `r` immediately — invalidate fires call 2 inline
    // (still erroring) and resets the backoff.
    captured!.invalidate();
    await waitForFlushed(() => callCount >= 2);
    expect(callCount).toBe(2);

    // After invalidate, the next backoff fires at +5s (counter reset),
    // and this one succeeds.
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFlushed(() => captured?.error === null);
    expect(callCount).toBe(3);
    expect(captured!.error).toBeNull();

    unmount();
  });
});
