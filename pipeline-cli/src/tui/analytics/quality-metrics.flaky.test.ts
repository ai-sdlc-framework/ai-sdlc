/**
 * Tests for RFC-0025 §8 MTTR + recurrence + coverage metrics.
 * SUBSTRATE (AISDLC-302 Phase 1 / salvaged from PR #481).
 *
 * NOTE: recurrenceWindowDays is a single-window placeholder.
 * Phase 3 (AISDLC-304 / OQ-3) adds simultaneous multi-window (7d/30d/90d).
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeQualityMetrics } from './quality-metrics.js';

let workdir: string;
const NOW = new Date('2026-05-15T00:00:00.000Z');

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'quality-metrics-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeCaptures(lines: string[]): void {
  const dir = join(workdir, '_quality');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'captures.jsonl'), lines.join('\n') + '\n');
}

/**
 * Write a completed framework-bug task with a specific mtime so the MTTR
 * and recurrence computations (which use file mtime as the Done date proxy)
 * are deterministic regardless of the real wall-clock time.
 *
 * @param mtime - Desired file mtime. Defaults to 2026-05-10T00:00:00Z
 *   (before the test captures at 2026-05-13 and 2026-05-15).
 */
function writeCompletedTask(
  filename: string,
  subclass: string,
  mtime: Date = new Date('2026-05-10T00:00:00.000Z'),
): void {
  const dir = join(workdir, 'backlog', 'completed');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      '---',
      `id: ${filename.replace('.md', '')}`,
      `title: 'chore: investigate framework bug - ${subclass}'`,
      `status: Done`,
      `labels:`,
      `  - triage: framework-bug`,
      '---',
      '',
      `## Fix for ${subclass}`,
    ].join('\n'),
  );
  // Force a deterministic mtime so MTTR / recurrence tests don't depend on
  // the wall-clock time when the test suite runs.
  utimesSync(filePath, mtime, mtime);
}

describe('computeQualityMetrics', () => {
  it('returns zero metrics when no captures exist', () => {
    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
    });
    expect(result.totalCaptures).toBe(0);
    expect(result.frameworkBugCaptures).toBe(0);
    expect(result.ambiguousCaptures).toBe(0);
    expect(result.coverageRate).toBe(0);
    expect(result.mttr).toHaveLength(0);
    expect(result.meanMttrMs).toBeNull();
  });

  it('counts framework-bug and ambiguous captures', () => {
    writeCaptures([
      JSON.stringify({
        ts: '2026-05-13T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-contract-violated',
      }),
      JSON.stringify({
        ts: '2026-05-14T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-contract-violated',
      }),
      JSON.stringify({ ts: '2026-05-14T01:00:00Z', class: 'ambiguous' }),
    ]);
    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
    });
    expect(result.totalCaptures).toBe(3);
    expect(result.frameworkBugCaptures).toBe(2);
    expect(result.ambiguousCaptures).toBe(1);
    // classifiedCaptures = 2 (framework-bug) + 0 (ambiguous not classified) = 2 out of 3
    // But ambiguous is NOT classified — coverage = 2/3
    expect(result.coverageRate).toBeCloseTo(2 / 3);
  });

  it('records MTTR when a completed task exists for the subclass', () => {
    // Capture at 2026-05-13, fix completed ~2 days later (mtime)
    writeCaptures([
      JSON.stringify({
        ts: '2026-05-13T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-contract-violated',
      }),
    ]);
    writeCompletedTask('bug-contract-fix.md', 'framework-contract-violated');

    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
    });
    expect(result.mttr).toHaveLength(1);
    const entry = result.mttr[0]!;
    expect(entry.subclass).toBe('framework-contract-violated');
    expect(entry.remediatedAt).not.toBeNull();
    // MTTR should be non-negative (exact value depends on file mtime)
    expect(entry.mttrMs).not.toBeNull();
    expect(entry.mttrMs!).toBeGreaterThanOrEqual(0);
    expect(result.meanMttrMs).not.toBeNull();
  });

  it('returns null MTTR when subclass has captures but no fix', () => {
    writeCaptures([
      JSON.stringify({
        ts: '2026-05-13T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-gate-faulty',
      }),
    ]);
    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
    });
    expect(result.mttr).toHaveLength(1);
    expect(result.mttr[0]!.remediatedAt).toBeNull();
    expect(result.mttr[0]!.mttrMs).toBeNull();
    expect(result.meanMttrMs).toBeNull();
  });

  it('computes recurrence rate when a fix is followed by another capture', () => {
    // Capture before fix (2026-05-01), fix done on 2026-05-10 (file mtime),
    // recurrence capture on 2026-05-15 (5 days after fix, within 30-day window).
    writeCaptures([
      JSON.stringify({
        ts: '2026-05-01T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-sweep-incomplete',
      }),
      // Recurrence 5 days after fix (within 30-day window)
      JSON.stringify({
        ts: '2026-05-15T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-sweep-incomplete',
      }),
    ]);
    // Fix mtime = 2026-05-10; the recurrence at 2026-05-15 is 5 days after.
    writeCompletedTask(
      'bug-sweep-fix.md',
      'framework-sweep-incomplete',
      new Date('2026-05-10T00:00:00.000Z'),
    );

    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
      recurrenceWindowDays: 30,
    });
    // One fix, one recurrence
    expect(result.recurrence).toHaveLength(1);
    const entry = result.recurrence[0]!;
    expect(entry.subclass).toBe('framework-sweep-incomplete');
    expect(entry.fixes).toBe(1);
    expect(entry.recurrenceRate).toBeGreaterThan(0);
  });

  it('coverage rate is 1.0 when all captures are classified (no ambiguous)', () => {
    writeCaptures([
      JSON.stringify({
        ts: '2026-05-13T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-gate-faulty',
      }),
      JSON.stringify({ ts: '2026-05-14T00:00:00Z', class: 'operator-under-decided' }),
    ]);
    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
    });
    expect(result.coverageRate).toBe(1.0);
  });

  it('coverage rate is 0 when all captures are ambiguous', () => {
    writeCaptures([
      JSON.stringify({ ts: '2026-05-13T00:00:00Z', class: 'ambiguous' }),
      JSON.stringify({ ts: '2026-05-14T00:00:00Z', class: 'ambiguous' }),
    ]);
    const result = computeQualityMetrics({
      workDir: workdir,
      artifactsDir: workdir,
      now: () => NOW,
    });
    expect(result.coverageRate).toBe(0);
  });
});
