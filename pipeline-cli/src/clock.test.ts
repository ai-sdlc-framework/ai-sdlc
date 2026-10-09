import { describe, expect, it } from 'vitest';
import { now, setClock } from './clock.js';
import { withFixedClock } from './__test-helpers/with-fixed-clock.js';

describe('clock seam', () => {
  it('returns the system time by default', () => {
    const before = Date.now();
    const t = now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('setClock pins the time and the returned function restores it', () => {
    const restore = setClock(() => new Date('2026-09-10T12:00:00.000Z'));
    expect(now().toISOString()).toBe('2026-09-10T12:00:00.000Z');
    restore();
    expect(now().getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    expect(now().toISOString()).not.toBe('2026-09-10T12:00:00.000Z');
  });
});

describe('withFixedClock', () => {
  it('fixes the seam and Date for the duration of fn, then restores both', async () => {
    const result = await withFixedClock('2026-09-10T12:00:00.000Z', async () => {
      expect(now().toISOString()).toBe('2026-09-10T12:00:00.000Z');
      expect(Date.now()).toBe(Date.parse('2026-09-10T12:00:00.000Z'));
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(now().toISOString()).not.toBe('2026-09-10T12:00:00.000Z');
  });

  it('restores the clock when fn throws', async () => {
    await expect(
      withFixedClock('2026-09-10T12:00:00.000Z', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(now().toISOString()).not.toBe('2026-09-10T12:00:00.000Z');
  });

  it('rejects an invalid ISO date', async () => {
    await expect(withFixedClock('nope', () => 1)).rejects.toThrow(/invalid ISO date/);
  });
});
