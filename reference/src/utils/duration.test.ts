import { describe, it, expect } from 'vitest';
import { parseDuration } from './duration.js';

describe('parseDuration', () => {
  it('parses PT30S to 30000ms', () => {
    expect(parseDuration('PT30S')).toBe(30_000);
  });

  it('parses PT10M to 600000ms', () => {
    expect(parseDuration('PT10M')).toBe(600_000);
  });

  it('parses PT1H to 3600000ms', () => {
    expect(parseDuration('PT1H')).toBe(3_600_000);
  });

  it('parses PT24H to 86400000ms', () => {
    expect(parseDuration('PT24H')).toBe(86_400_000);
  });

  it('parses combined PT1H30M15S', () => {
    expect(parseDuration('PT1H30M15S')).toBe(1 * 3_600_000 + 30 * 60_000 + 15 * 1_000);
  });

  it('throws for invalid string', () => {
    expect(() => parseDuration('invalid')).toThrow('Invalid ISO 8601 duration');
  });

  it('throws for empty duration PT', () => {
    expect(() => parseDuration('PT')).toThrow('Invalid ISO 8601 duration');
  });
});
