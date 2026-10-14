import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUSY_INTERVAL_MS,
  DEFAULT_DEBOUNCE_MS,
  IDLE_INTERVAL_MS,
  nextIntervalMs,
  startScheduler,
} from './scheduler.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('scheduler (AC3)', () => {
  it('picks the busy interval while PRs are open, else the idle one', () => {
    expect(nextIntervalMs(2)).toBe(BUSY_INTERVAL_MS);
    expect(nextIntervalMs(0)).toBe(IDLE_INTERVAL_MS);
  });

  it('reconciles at start, once per debounced wake-file touch, and on the timer, with no model', async () => {
    let m: number | undefined;
    const reconcile = vi.fn(() => 1);
    const s = startScheduler({ wakeFile: '/w', reconcile, mtime: () => m });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    m = 100;
    await vi.advanceTimersByTimeAsync(1000);
    m = 200; // a second touch inside the debounce window coalesces
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(reconcile).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(BUSY_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(3);
    s.stop();
    await vi.advanceTimersByTimeAsync(BUSY_INTERVAL_MS * 2);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('falls back to the idle timer with no open PRs and survives a failing pass', async () => {
    const reconcile = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(0);
    const s = startScheduler({ wakeFile: '/w', reconcile, mtime: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BUSY_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(IDLE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(2);
    s.stop();
  });
});
