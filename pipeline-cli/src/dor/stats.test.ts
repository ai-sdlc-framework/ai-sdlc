/**
 * Stats aggregation tests (RFC-0011 Phase 5 / AISDLC-115.6).
 *
 * Mirrors the calibration-log.test.ts pattern: write fake entries to a
 * tmp JSONL via `appendCalibrationEntry`, then exercise `loadEntries` +
 * `aggregateByAuthor` / `aggregateByGate` directly. CLI smoke tests live
 * in dor-stats.cli.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCalibrationEntry } from './calibration-log.js';
import {
  aggregateByAuthor,
  aggregateByGate,
  filterByWindow,
  loadEntries,
  overrideRate,
  passRate,
} from './stats.js';
import type { RefinementVerdict } from './types.js';

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-stats-'));
  logPath = join(tmp, 'cal.jsonl');
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function v(over: Partial<RefinementVerdict> = {}): RefinementVerdict {
  return {
    issueId: over.issueId ?? 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    overallConfidence: 'medium',
    gates: [],
    signedAt: '2026-05-01T00:00:00.000Z',
    evaluatorVersion: 'test',
    summary: '',
    questions: [],
    ...over,
  };
}

/**
 * Seed a 20-entry fixture spanning the last week with a deterministic
 * mix of admit / needs-clarification / override + author + gate failures.
 * Returns the count of each outcome bucket so test assertions can avoid
 * hardcoding magic numbers.
 */
function seedFixture(): { admits: number; ncs: number; overrides: number } {
  const now = Date.parse('2026-05-01T12:00:00.000Z');
  const dayMs = 24 * 60 * 60 * 1000;
  // 10 admits by alice on day-0 to day-2
  for (let i = 0; i < 10; i++) {
    appendCalibrationEntry(
      {
        verdict: v({ issueId: `i-${i}`, overallVerdict: 'admit' }),
        outcome: 'admit',
        author: 'alice',
      },
      { filePath: logPath, now: () => new Date(now - i * 1000) },
    );
  }
  // 6 needs-clarification by bob with mixed failed gates
  const ncGates: number[][] = [
    [1],
    [2, 5],
    [2],
    [5, 6],
    [3, 5],
    [], // edge: nc with no failed gates (e.g. all gates skipped)
  ];
  for (let i = 0; i < 6; i++) {
    const gates = ncGates[i]!.map((id) => ({
      gateId: id as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      verdict: 'fail' as const,
      severity: 'block' as const,
      stage: 'A' as const,
      confidence: 'high' as const,
    }));
    appendCalibrationEntry(
      {
        verdict: v({
          issueId: `nc-${i}`,
          overallVerdict: 'needs-clarification',
          gates,
        }),
        outcome: 'needs-clarification',
        author: 'bob',
      },
      { filePath: logPath, now: () => new Date(now - dayMs - i * 1000) },
    );
  }
  // 3 overrides by maintainer carol
  for (let i = 0; i < 3; i++) {
    appendCalibrationEntry(
      {
        verdict: v({ issueId: `ov-${i}` }),
        outcome: 'override',
        author: 'carol',
      },
      { filePath: logPath, now: () => new Date(now - 2 * dayMs - i * 1000) },
    );
  }
  // 1 admit with no author (the (unknown) bucket)
  appendCalibrationEntry(
    { verdict: v({ issueId: 'anon' }), outcome: 'admit' },
    { filePath: logPath, now: () => new Date(now - 3 * dayMs) },
  );
  return { admits: 10, ncs: 6, overrides: 3 };
}

describe('loadEntries', () => {
  it('returns [] when the file does not exist', () => {
    expect(loadEntries(join(tmp, 'nope.jsonl'))).toEqual([]);
  });

  it('parses every JSONL line', () => {
    seedFixture();
    const entries = loadEntries(logPath);
    expect(entries.length).toBe(20);
  });

  it('skips malformed lines silently', () => {
    appendCalibrationEntry({ verdict: v() }, { filePath: logPath });
    // Append a junk line to simulate a partial write.
    appendFileSync(logPath, 'not-json\n');
    appendCalibrationEntry({ verdict: v({ issueId: 'after-junk' }) }, { filePath: logPath });
    const entries = loadEntries(logPath);
    expect(entries.map((e) => e.issueId)).toEqual(['AISDLC-test', 'after-junk']);
  });
});

describe('filterByWindow', () => {
  it('returns entries within [since, until]', () => {
    seedFixture();
    const all = loadEntries(logPath);
    const within = filterByWindow(all, {
      since: '2026-04-29T00:00:00.000Z',
      until: '2026-05-01T13:00:00.000Z',
    });
    // 10 admits + 6 ncs + 3 overrides = 19 (anon is on 2026-04-28).
    expect(within.length).toBe(19);
  });

  it('without bounds returns all entries', () => {
    seedFixture();
    const all = loadEntries(logPath);
    expect(filterByWindow(all).length).toBe(20);
  });
});

describe('aggregateByAuthor', () => {
  it('buckets entries by author and computes verdict counts', () => {
    seedFixture();
    const grouped = aggregateByAuthor(loadEntries(logPath));
    expect(grouped.groups.alice).toEqual({ admit: 10, nc: 0, override: 0, total: 10 });
    expect(grouped.groups.bob).toEqual({ admit: 0, nc: 6, override: 0, total: 6 });
    expect(grouped.groups.carol).toEqual({ admit: 0, nc: 0, override: 3, total: 3 });
    // Anonymous admit entry lands in (unknown).
    expect(grouped.groups['(unknown)']).toEqual({ admit: 1, nc: 0, override: 0, total: 1 });
    expect(grouped.totals.total).toBe(20);
  });
});

describe('aggregateByGate', () => {
  it('contributes an entry to every gate it failed', () => {
    seedFixture();
    const grouped = aggregateByGate(loadEntries(logPath));
    // ncGates contained: [1], [2,5], [2], [5,6], [3,5], [].
    // gate-2 appears in 2 entries; gate-5 appears in 3; gate-1, 3, 6 in 1 each.
    expect(grouped.groups['gate-1'].total).toBe(1);
    expect(grouped.groups['gate-2'].total).toBe(2);
    expect(grouped.groups['gate-3'].total).toBe(1);
    expect(grouped.groups['gate-5'].total).toBe(3);
    expect(grouped.groups['gate-6'].total).toBe(1);
    // (none) bucket has the 10 admits + 1 anon admit + 3 overrides + 1 nc with no failed gates = 15
    expect(grouped.groups['(none)'].total).toBe(15);
    expect(grouped.totals.total).toBe(20);
  });
});

describe('passRate / overrideRate', () => {
  it('computes pass rate ignoring overrides', () => {
    const b = { admit: 8, nc: 2, override: 5, total: 15 };
    // 8 / (8 + 2) = 0.8
    expect(passRate(b)).toBeCloseTo(0.8);
  });

  it('returns 0 when no verdict-bearing rows', () => {
    expect(passRate({ admit: 0, nc: 0, override: 5, total: 5 })).toBe(0);
  });

  it('overrideRate is share of all entries', () => {
    expect(overrideRate({ admit: 8, nc: 2, override: 5, total: 15 })).toBeCloseTo(5 / 15);
  });

  it('overrideRate returns 0 on empty', () => {
    expect(overrideRate({ admit: 0, nc: 0, override: 0, total: 0 })).toBe(0);
  });
});
