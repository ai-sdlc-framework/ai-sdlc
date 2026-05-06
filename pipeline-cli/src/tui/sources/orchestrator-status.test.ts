/**
 * Tests for the orchestrator status poller (RFC-0023 Phase 2 / AISDLC-178.2).
 *
 * Covers:
 *   - Pure async fetcher: success path returns the status payload;
 *     thrown errors are caught + collapsed to source-unavailable.
 *   - React hook: mount fetch, interval polling, unmount clears the
 *     timer, error surfacing.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import {
  fetchOrchestratorStatus,
  ORCHESTRATOR_STATUS_POLL_INTERVAL_MS,
  useOrchestratorStatus,
  type FetchOrchestratorStatusResult,
} from './orchestrator-status.js';
import type { OrchestratorStatus } from '../../orchestrator/index.js';

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
 * having committed — async fetchers (this file's hook) need both the
 * awaited promise to resolve AND the subsequent setState to commit
 * before `state.error`/`state.data` is assertable.
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

describe('fetchOrchestratorStatus (pure)', () => {
  it('returns the status payload via the injected frontier adapter', async () => {
    const result = await fetchOrchestratorStatus({
      adapters: { frontier: () => [{ id: 'AISDLC-1', title: 'one' }] },
    });
    expect(result.error).toBeNull();
    expect(result.status).not.toBeNull();
    expect(result.status!.queueDepth).toBe(1);
    expect(result.status!.frontier[0].id).toBe('AISDLC-1');
  });

  it('collapses a thrown frontier into source-unavailable', async () => {
    const result = await fetchOrchestratorStatus({
      adapters: {
        frontier: () => {
          throw new Error('graph corrupt');
        },
      },
    });
    expect(result.status).toBeNull();
    expect(result.error).toBe('source-unavailable');
  });
});

// ── Hook ──────────────────────────────────────────────────────────────

function HookProbe({
  capture,
  fetcher,
  intervalMs,
}: {
  capture: (state: ReturnType<typeof useOrchestratorStatus>) => void;
  fetcher: () => Promise<FetchOrchestratorStatusResult>;
  intervalMs?: number;
}): React.ReactElement {
  const state = useOrchestratorStatus({ fetcher, intervalMs });
  React.useEffect(() => {
    capture(state);
  });
  return React.createElement(Text, null, state.data ? 'ok' : 'pending');
}

describe('useOrchestratorStatus (hook)', () => {
  it('exposes the default 10s cadence per RFC-0023 §6.2', () => {
    expect(ORCHESTRATOR_STATUS_POLL_INTERVAL_MS).toBe(10_000);
  });

  it('fetches on mount + polls every intervalMs', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const stubStatus: OrchestratorStatus = {
      frontier: [],
      queueDepth: 0,
      lastTick: null,
      config: {
        workDir: '/tmp',
        tickIntervalSec: 30,
        maxConcurrent: 1,
        maxTicks: null,
        dryRun: true,
      },
      enabled: false,
      blocked: [],
    };
    const fetcher = async (): Promise<FetchOrchestratorStatusResult> => {
      callCount += 1;
      return { status: stubStatus, error: null };
    };

    const { unmount } = render(
      React.createElement(HookProbe, { capture: () => {}, fetcher, intervalMs: 100 }),
    );
    // Mount fetch is async — wait for the awaited promise + setState
    // to settle rather than guessing at a fixed flush count (AISDLC-188).
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(4);

    unmount();
  });

  it('clears the polling timer on unmount', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const fetcher = async (): Promise<FetchOrchestratorStatusResult> => {
      callCount += 1;
      return { status: null, error: 'source-unavailable' };
    };

    const { unmount } = render(
      React.createElement(HookProbe, { capture: () => {}, fetcher, intervalMs: 100 }),
    );
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(1);
  });

  it('surfaces fetcher errors via state.error', async () => {
    let captured: ReturnType<typeof useOrchestratorStatus> | null = null;
    const fetcher = async (): Promise<FetchOrchestratorStatusResult> => ({
      status: null,
      error: 'source-unavailable',
    });

    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        fetcher,
      }),
    );
    // Capture-via-useEffect with an async fetcher needs the awaited
    // promise to resolve, the setState to commit, AND the child capture
    // effect to fire — wait for the predicate (AISDLC-188).
    await waitForFlushed(() => captured?.error != null);
    expect(captured!.error).toBe('source-unavailable');
    expect(captured!.data).toBeNull();
    unmount();
  });
});
