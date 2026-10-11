import { afterEach, describe, expect, it } from 'vitest';
import { now, setClock } from './clock.js';

describe('clock seam', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it('reads the system time by default', () => {
    const before = Date.now();
    const t = now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('can be pinned and restored', () => {
    const pinned = new Date('2026-10-10T00:00:00Z');
    restore = setClock(() => pinned);
    expect(now()).toBe(pinned);
    restore();
    restore = undefined;
    expect(now().getTime()).toBeGreaterThan(pinned.getTime());
  });
});
