/**
 * Tests for `cli-quality-corpus aggregate` — SUBSTRATE (AISDLC-302 Phase 1).
 *
 * Validates the pure `aggregateQualityCorpus()` function — no CLI I/O.
 * Salvaged from PR #481 (AISDLC-270).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aggregateQualityCorpus, buildQualityCorpusCli, renderTable } from './quality-corpus.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' })),
}));

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

describe('aggregateQualityCorpus prs-closed-unmerged (AISDLC-831)', () => {
  it('emits the metric when PRs are supplied and omits it otherwise', () => {
    const now = () => new Date('2026-10-14T00:00:00Z');
    const withPrs = aggregateQualityCorpus({
      artifactsDir: '/nonexistent-artifacts',
      workDir: '/nonexistent-work',
      now,
      prs: [
        {
          number: 7,
          state: 'CLOSED',
          closedAt: '2026-10-13T00:00:00Z',
          headRefName: 'ai-sdlc/aisdlc-1-x',
        },
      ],
    });
    expect(withPrs['prs-closed-unmerged']?.total).toBe(1);
    expect(withPrs['prs-closed-unmerged']?.byCause.unknown).toBe(1);
    const without = aggregateQualityCorpus({
      artifactsDir: '/nonexistent-artifacts',
      workDir: '/nonexistent-work',
      now,
    });
    expect(without['prs-closed-unmerged']).toBeUndefined();
  });
});

describe('quality-corpus prs-closed-unmerged rendering and CLI (AISDLC-831)', () => {
  const now = () => new Date('2026-10-14T00:00:00Z');
  const prs = [
    {
      number: 7,
      state: 'CLOSED',
      closedAt: '2026-10-13T00:00:00Z',
      headRefName: 'ai-sdlc/aisdlc-1-x',
    },
  ];

  it('renders the closed-unmerged section in the table', () => {
    const report = aggregateQualityCorpus({
      artifactsDir: '/nonexistent-artifacts',
      workDir: '/nonexistent-work',
      now,
      prs,
    });
    const text = renderTable(report);
    expect(text).toContain('PRs closed unmerged since');
    expect(text).toContain('Total: 1');
    expect(text).toContain('#7');
  });

  it('runs the aggregate command in json and table formats', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const argv = process.argv;
    try {
      for (const fmt of ['json', 'table']) {
        process.argv = [
          'node',
          'cli-quality-corpus',
          'aggregate',
          '--artifacts-dir',
          workdir,
          '--work-dir',
          workdir,
          '--recurrence-windows',
          '7d',
          '--format',
          fmt,
        ];
        await buildQualityCorpusCli().parseAsync();
      }
      expect(out).toHaveBeenCalled();
    } finally {
      process.argv = argv;
      out.mockRestore();
    }
  });
});
