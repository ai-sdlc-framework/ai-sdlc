import { describe, expect, it } from 'vitest';
import { now } from './clock.js';

describe('now', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const t = now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
