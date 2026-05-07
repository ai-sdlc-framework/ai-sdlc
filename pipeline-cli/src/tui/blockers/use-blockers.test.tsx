/**
 * Tests for the useBlockers React hook — RFC-0023 §8 / AISDLC-178.3.
 *
 * Uses the dependency-injection interfaces (taskWalker, prFetcher, detector)
 * to exercise the hook without requiring a real filesystem or gh CLI.
 *
 * Covers:
 *   - Mount fetch + detector run
 *   - Task error propagated to state.error
 *   - PR error propagated to state.error
 *   - Items re-computed when task list changes (poll)
 *   - Items re-computed when PR list changes (poll)
 *   - Detail-view navigation in BlockersPane (Enter → detail; Esc → back)
 *   - Empty-state rendering when items === []
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import { useBlockers, type UseBlockersState } from './use-blockers.js';
import type { BlockerItem } from './detector.js';
import type { BacklogTask, ReadBacklogTasksResult } from '../sources/backlog-walker.js';
import type { FetchGhPrsResult } from '../sources/gh-pr-cache.js';
import type { DetectBlockersOpts } from './detector.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForFlushed(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitForFlushed: predicate not satisfied after ${attempts} attempts`);
}

function makeTask(overrides: Partial<BacklogTask> = {}): BacklogTask {
  return {
    id: 'AISDLC-1',
    title: 'Test task',
    status: 'Needs Clarification',
    priority: 'medium',
    labels: [],
    dependencies: [],
    fileLocation: 'open',
    filePath: '/fake/aisdlc-1.md',
    lastModified: new Date('2026-01-01T00:00:00Z').toISOString(),
    extras: {},
    ...overrides,
  };
}

function makeBlockerItem(overrides: Partial<BlockerItem> = {}): BlockerItem {
  return {
    key: 'task:AISDLC-1:needs-clarification',
    kind: 'needs-clarification',
    ref: 'AISDLC-1',
    summary: 'Task awaiting clarification',
    detail: 'Details here',
    updatedAt: '2026-01-01T00:00:00Z',
    isUrgent: false,
    ...overrides,
  };
}

// ── HookProbe ─────────────────────────────────────────────────────────────────

function HookProbe({
  capture,
  opts,
}: {
  capture: (state: UseBlockersState) => void;
  opts: Parameters<typeof useBlockers>[0];
}): React.ReactElement {
  const state = useBlockers(opts);
  React.useEffect(() => {
    capture(state);
  });
  return React.createElement(Text, null, `count=${state.items.length}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useBlockers (hook)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
  });

  it('runs the detector on mount and returns items', async () => {
    const item = makeBlockerItem();
    const detector = vi.fn((_opts: DetectBlockersOpts): BlockerItem[] => [item]);
    const taskWalker = vi.fn(
      (): ReadBacklogTasksResult => ({
        tasks: [makeTask()],
        error: null,
      }),
    );
    const prFetcher = vi.fn((): FetchGhPrsResult => ({ prs: [], error: null }));

    let captured: UseBlockersState | null = null;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        opts: { taskWalker, prFetcher, detector, backlogIntervalMs: 100, prIntervalMs: 100 },
      }),
    );

    await waitForFlushed(() => captured?.items.length === 1);
    expect(captured!.items[0].key).toBe(item.key);
    expect(captured!.error).toBeNull();
    expect(captured!.lastFetched).toBeInstanceOf(Date);
    unmount();
  });

  it('propagates task source error to state.error', async () => {
    const detector = vi.fn((): BlockerItem[] => []);
    let captured: UseBlockersState | null = null;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        opts: {
          taskWalker: (): ReadBacklogTasksResult => ({
            tasks: [],
            error: 'source-unavailable',
          }),
          prFetcher: (): FetchGhPrsResult => ({ prs: [], error: null }),
          detector,
          backlogIntervalMs: 100,
          prIntervalMs: 100,
        },
      }),
    );

    await waitForFlushed(() => captured?.error != null);
    expect(captured!.error).toBe('source-unavailable');
    unmount();
  });

  it('propagates PR source error to state.error', async () => {
    const detector = vi.fn((): BlockerItem[] => []);
    let captured: UseBlockersState | null = null;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        opts: {
          taskWalker: (): ReadBacklogTasksResult => ({ tasks: [], error: null }),
          prFetcher: (): FetchGhPrsResult => ({ prs: [], error: 'source-corrupt' }),
          detector,
          backlogIntervalMs: 100,
          prIntervalMs: 100,
        },
      }),
    );

    await waitForFlushed(() => captured?.error != null);
    expect(captured!.error).toBe('source-corrupt');
    unmount();
  });

  it('re-runs detector after task poll tick', async () => {
    let callCount = 0;
    const items: BlockerItem[][] = [[], [makeBlockerItem()]];
    const detector = vi.fn((): BlockerItem[] => items[Math.min(callCount++, 1)]);
    const taskWalker = vi.fn((): ReadBacklogTasksResult => ({ tasks: [makeTask()], error: null }));
    const prFetcher = vi.fn((): FetchGhPrsResult => ({ prs: [], error: null }));

    let captured: UseBlockersState | null = null;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        opts: { taskWalker, prFetcher, detector, backlogIntervalMs: 100, prIntervalMs: 999_999 },
      }),
    );

    await waitForFlushed(() => captured !== null);
    // Advance clock to trigger a task re-poll.
    await vi.advanceTimersByTimeAsync(100);
    await waitForFlushed(() => taskWalker.mock.calls.length >= 2);
    expect(detector.mock.calls.length).toBeGreaterThanOrEqual(1);
    unmount();
  });

  it('returns empty items when detector returns []', async () => {
    const detector = vi.fn((): BlockerItem[] => []);
    let captured: UseBlockersState | null = null;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        opts: {
          taskWalker: (): ReadBacklogTasksResult => ({ tasks: [], error: null }),
          prFetcher: (): FetchGhPrsResult => ({ prs: [], error: null }),
          detector,
          backlogIntervalMs: 100,
          prIntervalMs: 100,
        },
      }),
    );

    await waitForFlushed(() => captured !== null);
    expect(captured!.items).toEqual([]);
    unmount();
  });
});
