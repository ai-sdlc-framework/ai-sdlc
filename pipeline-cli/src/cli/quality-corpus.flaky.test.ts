/**
 * Tests for `cli-quality-corpus aggregate` — SUBSTRATE (AISDLC-302 Phase 1).
 *
 * Validates the pure `aggregateQualityCorpus()` function — no CLI I/O.
 * Salvaged from PR #481 (AISDLC-270).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregateQualityCorpus } from './quality-corpus.js';

let workdir: string;
const NOW = new Date('2026-05-15T00:00:00.000Z');

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'quality-corpus-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeCaptures(lines: string[]): void {
  const dir = join(workdir, '_quality');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'captures.jsonl'), lines.join('\n') + '\n');
}

describe('aggregateQualityCorpus', () => {
  it('returns empty report when no captures file exists', () => {
    const report = aggregateQualityCorpus({
      artifactsDir: workdir,
      workDir: workdir,
      now: () => NOW,
    });
    expect(report.reliabilityTrend.available).toBe(false);
    expect(report.metrics.totalCaptures).toBe(0);
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it('returns reliability trend + metrics when captures exist', () => {
    writeCaptures([
      JSON.stringify({
        ts: '2026-05-14T00:00:00Z',
        class: 'framework-misbehaved',
        subclass: 'framework-contract-violated',
      }),
      JSON.stringify({ ts: '2026-05-13T00:00:00Z', class: 'ambiguous' }),
    ]);
    const report = aggregateQualityCorpus({
      artifactsDir: workdir,
      workDir: workdir,
      now: () => NOW,
    });
    expect(report.reliabilityTrend.available).toBe(true);
    expect(report.reliabilityTrend.thisWeek).toBeGreaterThan(0);
    expect(report.metrics.totalCaptures).toBe(2);
    expect(report.metrics.frameworkBugCaptures).toBe(1);
    expect(report.metrics.ambiguousCaptures).toBe(1);
  });

  it('respects recurrenceWindows parameter (OQ-3 multi-window)', () => {
    // Verify the multi-window option is forwarded and returns the correct number of windows.
    const report = aggregateQualityCorpus({
      artifactsDir: workdir,
      workDir: workdir,
      now: () => NOW,
      recurrenceWindows: ['7d'],
    });
    expect(report).toBeDefined();
    // Passing a single window should produce exactly one recurrenceByWindow entry
    expect(report.metrics.recurrenceByWindow).toHaveLength(1);
    expect(report.metrics.recurrenceByWindow[0]!.window).toBe('7d');
  });
});
