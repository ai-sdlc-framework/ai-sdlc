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
}: {
  capture: (state: ReturnType<typeof useGhPrs>) => void;
  fetcher: () => FetchGhPrsResult;
  intervalMs?: number;
  ttlMs?: number;
  clock?: () => number;
}): React.ReactElement {
  const state = useGhPrs({ fetcher, intervalMs, ttlMs, clock });
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
