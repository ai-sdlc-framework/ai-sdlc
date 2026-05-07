/**
 * Tests for the RFC-0025 reliability-trend reader (AISDLC-178.6 AC#8).
 *
 * The AC#8 contract is "degrades gracefully to 'no data' when not"; the
 * reader uses `available: false` as the sentinel that the formatter
 * surfaces as the "no data" label.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FRAMEWORK_QUALITY_CAPTURES_FILE,
  FRAMEWORK_QUALITY_DIRNAME,
  readReliabilityTrend,
} from './quality-reader.js';

let workdir: string;
const NOW = new Date('2026-05-15T00:00:00.000Z');

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'quality-reader-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeCaptures(lines: string[]): void {
  const dir = join(workdir, FRAMEWORK_QUALITY_DIRNAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FRAMEWORK_QUALITY_CAPTURES_FILE), lines.join('\n') + '\n');
}

describe('readReliabilityTrend (graceful degradation — AC#8)', () => {
  it('returns available=false when the file is missing', () => {
    const result = readReliabilityTrend({ artifactsDir: workdir, now: () => NOW });
    expect(result).toEqual({ available: false, thisWeek: 0, lastWeek: 0, delta: 0 });
  });

  it('returns available=false when the file is empty', () => {
    writeCaptures([]);
    const result = readReliabilityTrend({ artifactsDir: workdir, now: () => NOW });
    expect(result.available).toBe(false);
  });

  it('returns available=false when no records have valid ts fields', () => {
    writeCaptures([
      JSON.stringify({ class: 'framework-misbehaved' }), // missing ts
      'not json',
      JSON.stringify({ ts: 'not-a-date' }),
    ]);
    const result = readReliabilityTrend({ artifactsDir: workdir, now: () => NOW });
    expect(result.available).toBe(false);
  });

  it('counts captures in this-week vs last-week windows', () => {
    // NOW = 2026-05-15, this week = [2026-05-08, 2026-05-15], last week = [2026-05-01, 2026-05-08).
    writeCaptures([
      JSON.stringify({ ts: '2026-05-14T12:00:00Z', class: 'a' }), // this week
      JSON.stringify({ ts: '2026-05-13T00:00:00Z', class: 'b' }), // this week
      JSON.stringify({ ts: '2026-05-05T12:00:00Z', class: 'c' }), // last week
      JSON.stringify({ ts: '2026-04-01T00:00:00Z', class: 'd' }), // older — ignored
    ]);
    const result = readReliabilityTrend({ artifactsDir: workdir, now: () => NOW });
    expect(result.available).toBe(true);
    expect(result.thisWeek).toBe(2);
    expect(result.lastWeek).toBe(1);
    expect(result.delta).toBe(1);
  });

  it('reports a NEGATIVE delta when this week has fewer captures (improving trend)', () => {
    writeCaptures([
      JSON.stringify({ ts: '2026-05-13T00:00:00Z' }), // this week
      JSON.stringify({ ts: '2026-05-04T00:00:00Z' }), // last week
      JSON.stringify({ ts: '2026-05-05T00:00:00Z' }), // last week
      JSON.stringify({ ts: '2026-05-06T00:00:00Z' }), // last week
    ]);
    const result = readReliabilityTrend({ artifactsDir: workdir, now: () => NOW });
    expect(result.thisWeek).toBe(1);
    expect(result.lastWeek).toBe(3);
    expect(result.delta).toBe(-2);
  });
});
