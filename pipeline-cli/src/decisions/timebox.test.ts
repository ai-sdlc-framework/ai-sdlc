/**
 * Tests for `decisions/timebox.ts` — RFC-0035 timebox parsing + expiry math
 * (AISDLC-447).
 */

import { describe, expect, it } from 'vitest';

import {
  TIMEBOX_CATEGORICAL_ALIASES,
  computeTimeboxExpiresAt,
  isTimeboxExpired,
  msRemainingUntil,
  parseIsoDurationToMs,
  parseTimebox,
} from './timebox.js';

describe('parseIsoDurationToMs', () => {
  it('parses PT4H to 4 hours', () => {
    expect(parseIsoDurationToMs('PT4H')).toBe(4 * 60 * 60 * 1000);
  });
  it('parses P1D to one day', () => {
    expect(parseIsoDurationToMs('P1D')).toBe(24 * 60 * 60 * 1000);
  });
  it('parses P7D to seven days', () => {
    expect(parseIsoDurationToMs('P7D')).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('parses P1W to seven days', () => {
    expect(parseIsoDurationToMs('P1W')).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('parses composite PT1H30M', () => {
    expect(parseIsoDurationToMs('PT1H30M')).toBe(90 * 60 * 1000);
  });
  it('parses P1DT2H', () => {
    expect(parseIsoDurationToMs('P1DT2H')).toBe(26 * 60 * 60 * 1000);
  });
  it('returns null on empty P', () => {
    expect(parseIsoDurationToMs('P')).toBeNull();
  });
  it('returns null on bare "T" with no time designators', () => {
    expect(parseIsoDurationToMs('PT')).toBeNull();
  });
  it('returns null on garbage', () => {
    expect(parseIsoDurationToMs('foo')).toBeNull();
    expect(parseIsoDurationToMs('4H')).toBeNull();
    expect(parseIsoDurationToMs('')).toBeNull();
  });
  it('returns null on negative-prefixed', () => {
    expect(parseIsoDurationToMs('-PT4H')).toBeNull();
  });
  it('returns null on fractional', () => {
    expect(parseIsoDurationToMs('PT1.5H')).toBeNull();
  });
  it('returns null on non-string', () => {
    expect(parseIsoDurationToMs(123 as unknown as string)).toBeNull();
  });
  it('accepts large P30D (one calendar month)', () => {
    expect(parseIsoDurationToMs('P30D')).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('parseTimebox', () => {
  it('resolves URGENT to PT4H', () => {
    const r = parseTimebox('URGENT');
    expect(r.duration).toBe('PT4H');
    expect(r.alias).toBe('URGENT');
    expect(r.durationMs).toBe(4 * 60 * 60 * 1000);
  });
  it('resolves 24H to P1D', () => {
    expect(parseTimebox('24H').duration).toBe('P1D');
  });
  it('resolves WEEK to P7D', () => {
    expect(parseTimebox('WEEK').duration).toBe('P7D');
  });
  it('resolves BACKLOG to P30D', () => {
    expect(parseTimebox('BACKLOG').duration).toBe('P30D');
  });
  it('matches aliases case-insensitively', () => {
    expect(parseTimebox('urgent').alias).toBe('URGENT');
    expect(parseTimebox('Week').alias).toBe('WEEK');
  });
  it('passes through literal ISO-8601 durations', () => {
    const r = parseTimebox('PT12H');
    expect(r.duration).toBe('PT12H');
    expect(r.alias).toBeUndefined();
    expect(r.durationMs).toBe(12 * 60 * 60 * 1000);
  });
  it('throws on empty input', () => {
    expect(() => parseTimebox('')).toThrow(/empty value/);
    expect(() => parseTimebox('   ')).toThrow(/empty value/);
  });
  it('throws on invalid input', () => {
    expect(() => parseTimebox('foo')).toThrow(/invalid value "foo"/);
  });
  it('throws with both ISO + alias examples in the error', () => {
    try {
      parseTimebox('nope');
    } catch (err) {
      expect((err as Error).message).toMatch(/ISO-8601/);
      expect((err as Error).message).toMatch(/URGENT/);
    }
  });
  it('every categorical alias parses to a finite positive duration', () => {
    for (const [alias, iso] of Object.entries(TIMEBOX_CATEGORICAL_ALIASES)) {
      const parsed = parseTimebox(alias);
      expect(parsed.duration).toBe(iso);
      expect(parsed.durationMs).toBeGreaterThan(0);
    }
  });
});

describe('computeTimeboxExpiresAt', () => {
  it('adds the duration to the opened-at timestamp', () => {
    const opened = new Date('2026-05-27T12:00:00Z');
    const expires = computeTimeboxExpiresAt(4 * 60 * 60 * 1000, opened);
    expect(expires).toBe('2026-05-27T16:00:00.000Z');
  });
  it('defaults openedAt to now', () => {
    const before = Date.now();
    const expires = computeTimeboxExpiresAt(1000);
    const after = Date.now();
    const t = Date.parse(expires);
    expect(t).toBeGreaterThanOrEqual(before + 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);
  });
  it('throws on non-positive durations', () => {
    expect(() => computeTimeboxExpiresAt(0)).toThrow();
    expect(() => computeTimeboxExpiresAt(-1)).toThrow();
    expect(() => computeTimeboxExpiresAt(Number.NaN)).toThrow();
  });
});

describe('msRemainingUntil', () => {
  it('returns positive when in the future', () => {
    const now = new Date('2026-05-27T12:00:00Z');
    const exp = '2026-05-27T16:00:00.000Z';
    expect(msRemainingUntil(exp, now)).toBe(4 * 60 * 60 * 1000);
  });
  it('returns negative when in the past', () => {
    const now = new Date('2026-05-27T16:00:00Z');
    const exp = '2026-05-27T12:00:00.000Z';
    expect(msRemainingUntil(exp, now)).toBe(-4 * 60 * 60 * 1000);
  });
  it('returns null on missing input', () => {
    expect(msRemainingUntil(null)).toBeNull();
    expect(msRemainingUntil(undefined)).toBeNull();
    expect(msRemainingUntil('')).toBeNull();
  });
  it('returns null on unparseable input', () => {
    expect(msRemainingUntil('not-a-date')).toBeNull();
  });
});

describe('isTimeboxExpired', () => {
  it('returns true when expiry is in the past', () => {
    expect(isTimeboxExpired('2026-05-27T12:00:00Z', new Date('2026-05-27T13:00:00Z'))).toBe(true);
  });
  it('returns false when expiry is in the future', () => {
    expect(isTimeboxExpired('2026-05-27T13:00:00Z', new Date('2026-05-27T12:00:00Z'))).toBe(false);
  });
  it('returns false when expiry is null (no timebox)', () => {
    expect(isTimeboxExpired(null)).toBe(false);
    expect(isTimeboxExpired(undefined)).toBe(false);
  });
  it('returns false when expiry equals now (not yet past)', () => {
    const t = '2026-05-27T12:00:00.000Z';
    expect(isTimeboxExpired(t, new Date(t))).toBe(false);
  });
});
