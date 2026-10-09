import { vi } from 'vitest';
import { setClock } from '../clock.js';

/**
 * Run `fn` with the clock fixed at `iso`: both the module `now()` seam and
 * `vi.useFakeTimers({ now })` (so stray `Date.now()` calls agree). Restores
 * real timers and the real clock afterwards, even when `fn` throws.
 *
 * Use whenever a test writes a fixed timestamp (AISDLC-769 convention).
 * Only `Date` is faked, so real I/O and `setTimeout` keep working.
 */
export async function withFixedClock<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error(`withFixedClock: invalid ISO date "${iso}"`);
  const restore = setClock(() => new Date(at.getTime()));
  vi.useFakeTimers({ now: at, toFake: ['Date'] });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
    restore();
  }
}
