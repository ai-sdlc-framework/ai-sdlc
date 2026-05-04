/**
 * Tests for the events.jsonl tail source (RFC-0023 Phase 2 / AISDLC-178.2).
 *
 * Covers:
 *   - Pure reader: missing dir, missing file, healthy file, corrupt-line
 *     skipping, in-memory cap, date-rotated path resolution.
 *   - React hook: polling lifecycle (mount kicks off, unmount clears),
 *     fetcher injection, error surfacing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import {
  EVENTS_BUFFER_CAP,
  EVENTS_POLL_INTERVAL_MS,
  readEventsTail,
  useEvents,
  type EventsTailReadResult,
} from './events-tail.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'tui-events-tail-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  cleanup();
  vi.useRealTimers();
});

const FROZEN_DATE = new Date('2026-05-04T10:00:00Z');
const frozenNow = (): Date => FROZEN_DATE;

function writeEventsFile(lines: string[]): string {
  const dir = join(workdir, '_orchestrator');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'events-2026-05-04.jsonl');
  writeFileSync(path, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
  return path;
}

describe('readEventsTail (pure)', () => {
  it('returns source-unavailable when artifacts dir is missing', () => {
    const result = readEventsTail({
      artifactsDir: join(workdir, 'does-not-exist'),
      now: frozenNow,
    });
    expect(result.events).toEqual([]);
    expect(result.error).toBe('source-unavailable');
  });

  it("returns null error + [] when dir exists but today's file is absent", () => {
    mkdirSync(join(workdir, '_orchestrator'), { recursive: true });
    const result = readEventsTail({ artifactsDir: workdir, now: frozenNow });
    expect(result.events).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('parses every JSONL event line', () => {
    writeEventsFile([
      JSON.stringify({ ts: '2026-05-04T09:00:00Z', type: 'OrchestratorTick', tick: 1 }),
      JSON.stringify({ ts: '2026-05-04T09:00:05Z', type: 'OrchestratorDispatched', taskId: 'A' }),
    ]);
    const result = readEventsTail({ artifactsDir: workdir, now: frozenNow });
    expect(result.error).toBeNull();
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe('OrchestratorTick');
    expect(result.events[1].taskId).toBe('A');
  });

  it('skips corrupt JSONL lines without throwing', () => {
    writeEventsFile([
      JSON.stringify({ ts: '2026-05-04T09:00:00Z', type: 'OrchestratorTick' }),
      '{not-json',
      JSON.stringify({ ts: '2026-05-04T09:00:10Z', type: 'OrchestratorIdleNoWork' }),
      '{"missingType":true}',
    ]);
    const result = readEventsTail({ artifactsDir: workdir, now: frozenNow });
    expect(result.error).toBeNull();
    expect(result.events.map((e) => e.type)).toEqual([
      'OrchestratorTick',
      'OrchestratorIdleNoWork',
    ]);
  });

  it('caps the buffer to the configured size', () => {
    const lines = Array.from({ length: 250 }, (_, i) =>
      JSON.stringify({ ts: '2026-05-04T09:00:00Z', type: 'OrchestratorTick', tick: i }),
    );
    writeEventsFile(lines);
    const result = readEventsTail({ artifactsDir: workdir, now: frozenNow, cap: 200 });
    expect(result.events).toHaveLength(200);
    // Should retain the last 200 (oldest dropped).
    expect(result.events[0].tick).toBe(50);
    expect(result.events[199].tick).toBe(249);
  });

  it('rotates by UTC date', () => {
    // Today's file (May 4) is empty/missing; yesterday's exists but is NOT read.
    const dir = join(workdir, '_orchestrator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events-2026-05-03.jsonl'),
      JSON.stringify({ ts: '2026-05-03T09:00:00Z', type: 'OrchestratorTick' }) + '\n',
    );
    const result = readEventsTail({ artifactsDir: workdir, now: frozenNow });
    expect(result.events).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('uses the default EVENTS_BUFFER_CAP when none provided', () => {
    const lines = Array.from({ length: EVENTS_BUFFER_CAP + 5 }, (_, i) =>
      JSON.stringify({ ts: '2026-05-04T09:00:00Z', type: 'OrchestratorTick', tick: i }),
    );
    writeEventsFile(lines);
    const result = readEventsTail({ artifactsDir: workdir, now: frozenNow });
    expect(result.events).toHaveLength(EVENTS_BUFFER_CAP);
  });
});

// ── Hook ──────────────────────────────────────────────────────────────

/**
 * Tiny harness — mounts useEvents in an Ink component. The `capture`
 * callback fires inside a `useEffect` so it sees post-effect state
 * updates (the mount fetch's setState lands AFTER the initial render,
 * so a same-render capture would only see the useState initialiser).
 */
function HookProbe({
  capture,
  fetcher,
  intervalMs,
}: {
  capture: (state: ReturnType<typeof useEvents>) => void;
  fetcher: (opts: { artifactsDir?: string }) => EventsTailReadResult;
  intervalMs?: number;
}): React.ReactElement {
  const state = useEvents({ fetcher, intervalMs });
  React.useEffect(() => {
    capture(state);
  });
  return React.createElement(Text, null, `count=${state.data.length}`);
}

/**
 * Polls `predicate()` until it returns true OR `attempts` is exhausted
 * (each iteration is a single setImmediate round-trip). Ink wraps a
 * custom React reconciler that schedules effects via the scheduler
 * package's `setImmediate`, so each round-trip yields back AFTER one
 * batch of effect callbacks fires. Use this for assertions that depend
 * on a setState having committed (typical capture-via-useEffect
 * pattern, plus the mount-fetch setState in this file's hook).
 *
 * AISDLC-188 root cause: under load on freshly-started CI runners,
 * 1-2 setImmediate round-trips occasionally weren't enough for the
 * React commit queue to drain a mount-fetch's setState into the
 * capture effect — the test would assert before the state landed. A
 * predicate-driven wait removes the dependency on a magic round count
 * and adapts to whatever the scheduler actually takes (each round is
 * a synchronous setImmediate, no real-clock wait under fake timers).
 */
async function waitForFlushed(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('useEvents (hook)', () => {
  it('fetches once on mount + every intervalMs tick', async () => {
    vi.useFakeTimers({
      now: 0,
      // Don't mock setImmediate — Ink's reconciler uses it to flush
      // effects, and our `flushEffects()` helper relies on it.
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const fetcher = (): EventsTailReadResult => {
      callCount += 1;
      return { events: [{ ts: 'x', type: 'OrchestratorTick' }], error: null, path: '/tmp/x' };
    };

    const { unmount } = render(
      React.createElement(HookProbe, { capture: () => {}, fetcher, intervalMs: 100 }),
    );

    // Mount fetch — wait for the effect to actually run rather than
    // assuming a fixed flush count (AISDLC-188 cold-CI race).
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    // Advance one interval — second fetch.
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    // Advance two more intervals.
    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(4);

    unmount();
  });

  it('clears the interval on unmount', async () => {
    vi.useFakeTimers({
      now: 0,
      // Don't mock setImmediate — Ink's reconciler uses it to flush
      // effects, and our `flushEffects()` helper relies on it.
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const fetcher = (): EventsTailReadResult => {
      callCount += 1;
      return { events: [], error: null, path: '/tmp/x' };
    };

    const { unmount } = render(
      React.createElement(HookProbe, { capture: () => {}, fetcher, intervalMs: 100 }),
    );
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(1); // No more fetches after unmount.
  });

  it('surfaces the error sentinel from the fetcher', async () => {
    const fetcher = (): EventsTailReadResult => ({
      events: [],
      error: 'source-unavailable',
      path: '/tmp/x',
    });

    let captured: ReturnType<typeof useEvents> | null = null;
    render(
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
    expect(captured!.lastFetched).toBeInstanceOf(Date);
  });

  it('uses the default poll interval when none provided', () => {
    expect(EVENTS_POLL_INTERVAL_MS).toBe(5_000);
  });
});
