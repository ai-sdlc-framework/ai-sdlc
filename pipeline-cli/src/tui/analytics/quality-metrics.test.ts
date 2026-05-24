/**
 * Tests for RFC-0025 §8 MTTR + multi-window recurrence + coverage metrics.
 * Phase 3 (AISDLC-304 / OQ-3 + OQ-8).
 *
 * Phase 3 changes tested here:
 *   - Multi-window recurrence: all three windows (7d / 30d / 90d)
 *     computed simultaneously in `recurrenceByWindow`.
 *   - `mttrLabel: 'MTTR (from first capture)'` present on every result.
 *   - `mttdV2: { enabled: false }` stub present on every result.
 *   - Multiple captures of the same fingerprint: MTTR clock anchors to
 *     the FIRST capture, subsequent captures are used for recurrence only.
 *   - Per-org window list override via `recurrenceWindows` opt.
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
  describe('zero-state', () => {
    it('returns zero metrics when no captures exist', () => {
      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.totalCaptures).toBe(0);
      expect(result.frameworkBugCaptures).toBe(0);
      expect(result.ambiguousCaptures).toBe(0);
      expect(result.coverageRate).toBe(0);
      expect(result.mttr).toHaveLength(0);
      expect(result.meanMttrMs).toBeNull();
      // Phase 3: recurrenceByWindow replaces single recurrence
      expect(result.recurrenceByWindow).toHaveLength(3);
      expect(result.recurrenceByWindow[0]!.window).toBe('7d');
      expect(result.recurrenceByWindow[1]!.window).toBe('30d');
      expect(result.recurrenceByWindow[2]!.window).toBe('90d');
      // All windows empty
      for (const rw of result.recurrenceByWindow) {
        expect(rw.entries).toHaveLength(0);
      }
    });
  });

  describe('mandatory Phase 3 fields', () => {
    it('always sets mttrLabel to "MTTR (from first capture)"', () => {
      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.mttrLabel).toBe('MTTR (from first capture)');
    });

    it('always sets mttdV2.enabled to false (substrate present but disabled)', () => {
      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.mttdV2).toBeDefined();
      expect(result.mttdV2.enabled).toBe(false);
    });
  });

  describe('capture counting', () => {
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
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.totalCaptures).toBe(3);
      expect(result.frameworkBugCaptures).toBe(2);
      expect(result.ambiguousCaptures).toBe(1);
      // classifiedCaptures = 2 (framework-bug); ambiguous is NOT classified
      expect(result.coverageRate).toBeCloseTo(2 / 3);
    });
  });

  describe('MTTR — OQ-8 first-capture clock', () => {
    it('records MTTR when a completed task exists for the subclass', () => {
      // Capture at 2026-05-13, fix completed ~2 days later (mtime 2026-05-10, before capture)
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
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.mttr).toHaveLength(1);
      const entry = result.mttr[0]!;
      expect(entry.subclass).toBe('framework-contract-violated');
      // firstCaptureAt preserves the raw ts string from the JSONL capture
      expect(entry.firstCaptureAt).toBe('2026-05-13T00:00:00Z');
      expect(entry.remediatedAt).not.toBeNull();
      // MTTR in ms — non-negative
      expect(entry.mttrMs).not.toBeNull();
      expect(entry.mttrMs!).toBeGreaterThanOrEqual(0);
      expect(result.meanMttrMs).not.toBeNull();
      // OQ-8 label
      expect(result.mttrLabel).toBe('MTTR (from first capture)');
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
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.mttr).toHaveLength(1);
      expect(result.mttr[0]!.remediatedAt).toBeNull();
      expect(result.mttr[0]!.mttrMs).toBeNull();
      expect(result.meanMttrMs).toBeNull();
    });

    it('anchors MTTR clock to the FIRST capture when multiple captures exist for the same fingerprint', () => {
      // Three captures of the same subclass at different times.
      // MTTR clock must start at the EARLIEST (first-capture) timestamp.
      writeCaptures([
        JSON.stringify({
          ts: '2026-05-01T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-sweep-incomplete',
        }),
        JSON.stringify({
          ts: '2026-05-05T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-sweep-incomplete',
        }),
        JSON.stringify({
          ts: '2026-05-08T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-sweep-incomplete',
        }),
      ]);
      // Fix done on 2026-05-10
      writeCompletedTask(
        'bug-sweep-fix.md',
        'framework-sweep-incomplete',
        new Date('2026-05-10T00:00:00.000Z'),
      );

      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.mttr).toHaveLength(1);
      const entry = result.mttr[0]!;
      expect(entry.subclass).toBe('framework-sweep-incomplete');
      // Clock starts at FIRST capture (2026-05-01), NOT at 2026-05-05 or 2026-05-08.
      // firstCaptureAt preserves the raw ts string from the JSONL capture.
      expect(entry.firstCaptureAt).toBe('2026-05-01T00:00:00Z');
      expect(entry.remediatedAt).not.toBeNull();
      // MTTR = fix_time - first_capture_time = 2026-05-10 - 2026-05-01 = 9 days
      const expectedMttrMs =
        new Date('2026-05-10T00:00:00.000Z').getTime() -
        new Date('2026-05-01T00:00:00.000Z').getTime();
      expect(entry.mttrMs).toBe(expectedMttrMs);
    });
  });

  describe('multi-window recurrence — OQ-3', () => {
    it('computes all three windows simultaneously (7d / 30d / 90d)', () => {
      // Fix on 2026-05-10; recurrence at 2026-05-15 = 5 days after fix.
      // Should appear in 7d ✓, 30d ✓, 90d ✓ windows (all contain 5-day gap).
      writeCaptures([
        JSON.stringify({
          ts: '2026-05-01T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-sweep-incomplete',
        }),
        JSON.stringify({
          ts: '2026-05-15T00:00:00Z', // 5 days after fix
          class: 'framework-misbehaved',
          subclass: 'framework-sweep-incomplete',
        }),
      ]);
      writeCompletedTask(
        'bug-sweep-fix.md',
        'framework-sweep-incomplete',
        new Date('2026-05-10T00:00:00.000Z'),
      );

      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });

      expect(result.recurrenceByWindow).toHaveLength(3);

      // 7d window: 5 days < 7d → recurrence detected
      const w7 = result.recurrenceByWindow.find((r) => r.window === '7d')!;
      expect(w7).toBeDefined();
      expect(w7.windowDays).toBe(7);
      expect(w7.entries).toHaveLength(1);
      expect(w7.entries[0]!.subclass).toBe('framework-sweep-incomplete');
      expect(w7.entries[0]!.recurrences).toBe(1);
      expect(w7.entries[0]!.fixes).toBe(1);
      expect(w7.entries[0]!.recurrenceRate).toBe(1.0);

      // 30d window: 5 days < 30d → recurrence detected
      const w30 = result.recurrenceByWindow.find((r) => r.window === '30d')!;
      expect(w30).toBeDefined();
      expect(w30.windowDays).toBe(30);
      expect(w30.entries[0]!.recurrences).toBe(1);
      expect(w30.entries[0]!.recurrenceRate).toBe(1.0);

      // 90d window: 5 days < 90d → recurrence detected
      const w90 = result.recurrenceByWindow.find((r) => r.window === '90d')!;
      expect(w90).toBeDefined();
      expect(w90.windowDays).toBe(90);
      expect(w90.entries[0]!.recurrences).toBe(1);
      expect(w90.entries[0]!.recurrenceRate).toBe(1.0);
    });

    it('recurrence within 7d but NOT within narrower windows — differential across windows', () => {
      // Fix on 2026-05-10; recurrence at 2026-05-14 = 4 days after fix.
      // Should appear in 7d ✓, 30d ✓, 90d ✓ (4 < all windows).
      // Separate test: recurrence at +35 days should appear in 90d only (not 7d, not 30d).
      writeCaptures([
        JSON.stringify({
          ts: '2026-04-01T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-gate-faulty',
        }),
        // 35 days after fix (2026-05-10 + 35d = 2026-06-14)
        JSON.stringify({
          ts: '2026-06-14T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-gate-faulty',
        }),
      ]);
      writeCompletedTask(
        'bug-gate-fix.md',
        'framework-gate-faulty',
        new Date('2026-05-10T00:00:00.000Z'),
      );

      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });

      const w7 = result.recurrenceByWindow.find((r) => r.window === '7d')!;
      const w30 = result.recurrenceByWindow.find((r) => r.window === '30d')!;
      const w90 = result.recurrenceByWindow.find((r) => r.window === '90d')!;

      // 35 days after fix → NOT within 7d or 30d, IS within 90d
      expect(w7.entries[0]!.recurrences).toBe(0);
      expect(w7.entries[0]!.recurrenceRate).toBe(0);

      expect(w30.entries[0]!.recurrences).toBe(0);
      expect(w30.entries[0]!.recurrenceRate).toBe(0);

      expect(w90.entries[0]!.recurrences).toBe(1);
      expect(w90.entries[0]!.recurrenceRate).toBe(1.0);
    });

    it('windows are sorted by ascending windowDays in output', () => {
      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        // Deliberately out of order to test sorting
        recurrenceWindows: ['90d', '7d', '30d'],
      });
      expect(result.recurrenceByWindow[0]!.windowDays).toBe(7);
      expect(result.recurrenceByWindow[1]!.windowDays).toBe(30);
      expect(result.recurrenceByWindow[2]!.windowDays).toBe(90);
    });

    it('supports a custom window list (per-org override)', () => {
      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['14d', '60d'],
      });
      expect(result.recurrenceByWindow).toHaveLength(2);
      expect(result.recurrenceByWindow[0]!.window).toBe('14d');
      expect(result.recurrenceByWindow[0]!.windowDays).toBe(14);
      expect(result.recurrenceByWindow[1]!.window).toBe('60d');
      expect(result.recurrenceByWindow[1]!.windowDays).toBe(60);
    });

    it('recurrence rate reflects multiple fixes and partial recurrences per window', () => {
      // Two separate fix events for the same subclass.
      // Only the second fix has a recurrence within 7d.
      writeCaptures([
        // Pre-fix-1 capture
        JSON.stringify({
          ts: '2026-04-01T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-silent-failure',
        }),
        // Recurrence 3 days after fix-2 (within 7d)
        JSON.stringify({
          ts: '2026-05-13T00:00:00Z',
          class: 'framework-misbehaved',
          subclass: 'framework-silent-failure',
        }),
      ]);
      // Fix-1 on 2026-04-20 — no recurrence within 7d
      writeCompletedTask(
        'bug-silent-fix-1.md',
        'framework-silent-failure',
        new Date('2026-04-20T00:00:00.000Z'),
      );
      // Fix-2 on 2026-05-10 — recurrence at 2026-05-13 (3 days later, within 7d)
      writeCompletedTask(
        'bug-silent-fix-2.md',
        'framework-silent-failure',
        new Date('2026-05-10T00:00:00.000Z'),
      );

      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        recurrenceWindows: ['7d', '30d', '90d'],
      });

      const w7 = result.recurrenceByWindow.find((r) => r.window === '7d')!;
      const entry = w7.entries.find((e) => e.subclass === 'framework-silent-failure')!;
      expect(entry).toBeDefined();
      // 2 fixes, 1 recurrence (only fix-2 is followed by a capture within 7d)
      expect(entry.fixes).toBe(2);
      expect(entry.recurrences).toBe(1);
      expect(entry.recurrenceRate).toBe(0.5);
    });
  });

  describe('coverage rate', () => {
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
        recurrenceWindows: ['7d', '30d', '90d'],
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
        recurrenceWindows: ['7d', '30d', '90d'],
      });
      expect(result.coverageRate).toBe(0);
    });
  });

  describe('quality-monitoring.yaml config loading', () => {
    it('reads recurrence windows from quality-monitoring.yaml when not specified in opts', () => {
      // Write a quality-monitoring.yaml with custom windows
      const configDir = join(workdir, '.ai-sdlc');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'quality-monitoring.yaml'),
        ['quality:', '  recurrence-windows:', '    - 14d', '    - 60d'].join('\n'),
      );

      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        // No recurrenceWindows opt → should load from config
      });
      expect(result.recurrenceByWindow).toHaveLength(2);
      expect(result.recurrenceByWindow[0]!.window).toBe('14d');
      expect(result.recurrenceByWindow[1]!.window).toBe('60d');
    });

    it('falls back to default windows when quality-monitoring.yaml is missing', () => {
      // No config file → should use default ['7d', '30d', '90d']
      const result = computeQualityMetrics({
        workDir: workdir,
        artifactsDir: workdir,
        now: () => NOW,
        // No recurrenceWindows, no config file
      });
      expect(result.recurrenceByWindow).toHaveLength(3);
      expect(result.recurrenceByWindow.map((r) => r.window)).toEqual(['7d', '30d', '90d']);
    });
  });
});
