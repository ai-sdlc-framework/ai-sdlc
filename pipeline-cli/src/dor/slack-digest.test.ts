/**
 * Slack digest tests (RFC-0011 Phase 5 / AISDLC-115.6).
 *
 * Drives `buildWeeklyDigest` + `renderMarkdownDigest` against a known
 * 20-entry fixture and asserts:
 *   - Window math (current + prior, equal length)
 *   - Top-3 gate ordering by entry count
 *   - Override Δ trend formatting
 *   - End-to-end markdown render is snapshot-stable
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCalibrationEntry } from './calibration-log.js';
import {
  buildDigestAggregate,
  buildWeeklyDigest,
  formatTrend,
  renderMarkdownDigest,
} from './slack-digest.js';
import type { GateId, RefinementVerdict } from './types.js';

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-digest-'));
  logPath = join(tmp, 'cal.jsonl');
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function v(over: Partial<RefinementVerdict> = {}): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
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

const NOW = new Date('2026-05-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * 20-entry fixture spanning 14 days back from NOW. Layout designed so
 * the digest produces predictable counts:
 *
 *   Current window (last 7 days): 10 admits + 4 ncs + 2 overrides
 *   Prior window (7-14 days ago): 3 admits + 0 ncs + 1 override
 *
 *   Failed gates in current window:
 *     gate-2: 3 entries (top)
 *     gate-5: 2 entries
 *     gate-3: 1 entry
 */
function seedFixture(): void {
  // Current window: day -1 to day -6
  for (let i = 0; i < 10; i++) {
    appendCalibrationEntry(
      { verdict: v({ issueId: `cur-admit-${i}` }), outcome: 'admit', author: 'alice' },
      { filePath: logPath, now: () => new Date(NOW.getTime() - (i + 1) * DAY * 0.5) },
    );
  }
  const ncGatesCurrent: GateId[][] = [[2], [2, 5], [2], [3, 5]];
  ncGatesCurrent.forEach((gates, i) => {
    appendCalibrationEntry(
      {
        verdict: v({
          issueId: `cur-nc-${i}`,
          overallVerdict: 'needs-clarification',
          gates: gates.map((g) => ({
            gateId: g,
            verdict: 'fail',
            severity: 'block',
            stage: 'A',
            confidence: 'high',
          })),
        }),
        outcome: 'needs-clarification',
        author: 'bob',
      },
      { filePath: logPath, now: () => new Date(NOW.getTime() - (i + 1) * DAY * 0.5 - 100) },
    );
  });
  for (let i = 0; i < 2; i++) {
    appendCalibrationEntry(
      { verdict: v({ issueId: `cur-ov-${i}` }), outcome: 'override', author: 'carol' },
      { filePath: logPath, now: () => new Date(NOW.getTime() - (i + 1) * DAY * 0.5 - 200) },
    );
  }
  // Prior window: day -8 to day -13
  for (let i = 0; i < 3; i++) {
    appendCalibrationEntry(
      { verdict: v({ issueId: `prior-admit-${i}` }), outcome: 'admit', author: 'alice' },
      { filePath: logPath, now: () => new Date(NOW.getTime() - 8 * DAY - i * DAY) },
    );
  }
  appendCalibrationEntry(
    { verdict: v({ issueId: 'prior-ov-0' }), outcome: 'override', author: 'carol' },
    { filePath: logPath, now: () => new Date(NOW.getTime() - 9 * DAY) },
  );
}

describe('formatTrend', () => {
  it('positive Δ', () => {
    expect(formatTrend(2)).toBe('+2 vs prior window');
  });
  it('negative Δ', () => {
    expect(formatTrend(-3)).toBe('-3 vs prior window');
  });
  it('zero Δ', () => {
    expect(formatTrend(0)).toBe('→ 0 vs prior window');
  });
});

describe('buildDigestAggregate', () => {
  it('separates current and prior windows of equal length', () => {
    seedFixture();
    const agg = buildDigestAggregate({ logPath, sinceDays: 7, now: NOW });
    // Current window totals: 10 admit + 4 nc + 2 override = 16
    expect(agg.totals.total).toBe(16);
    expect(agg.totals.admit).toBe(10);
    expect(agg.totals.nc).toBe(4);
    expect(agg.totals.override).toBe(2);
    // Prior window: 3 admits + 1 override = 4 (we only persist override count)
    expect(agg.priorOverrideCount).toBe(1);
    // Δ = 2 - 1 = +1
    expect(agg.overrideDelta).toBe(1);
    expect(agg.trend).toBe('+1 vs prior window');
  });

  it('orders top gates by entry count, descending, max 3', () => {
    seedFixture();
    const agg = buildDigestAggregate({ logPath, sinceDays: 7, now: NOW });
    expect(agg.topGates.length).toBeGreaterThan(0);
    expect(agg.topGates.length).toBeLessThanOrEqual(3);
    expect(agg.topGates[0]!.key).toBe('gate-2');
    expect(agg.topGates[0]!.bucket.total).toBe(3);
    expect(agg.topGates[1]!.key).toBe('gate-5');
    expect(agg.topGates[1]!.bucket.total).toBe(2);
  });

  it('handles empty log gracefully', () => {
    const agg = buildDigestAggregate({ logPath, sinceDays: 7, now: NOW });
    expect(agg.totals.total).toBe(0);
    expect(agg.topGates).toEqual([]);
    expect(agg.overrideDelta).toBe(0);
    expect(agg.trend).toBe('→ 0 vs prior window');
  });
});

describe('buildWeeklyDigest', () => {
  it('emits Slack Block Kit shape with 3 blocks + fallback text', () => {
    seedFixture();
    const digest = buildWeeklyDigest({ logPath, sinceDays: 7, now: NOW });
    expect(digest.blocks).toHaveLength(3);
    expect(digest.blocks[2]).toEqual({ type: 'divider' });
    expect(digest.fallbackText).toContain('DoR digest');
    expect(digest.fallbackText).toContain('gate-2');
    expect(digest.fallbackText).toContain('+1 vs prior window');
  });

  it('header block contains pass rate', () => {
    seedFixture();
    const digest = buildWeeklyDigest({ logPath, sinceDays: 7, now: NOW });
    const header = digest.blocks[0] as {
      type: string;
      text: { type: string; text: string };
    };
    // 10 admit / (10 admit + 4 nc) = 71.4%
    expect(header.text.text).toContain('71.4%');
    expect(header.text.text).toContain('DoR weekly digest');
  });
});

describe('renderMarkdownDigest', () => {
  it('produces a deterministic markdown snapshot', () => {
    seedFixture();
    const md = renderMarkdownDigest({ logPath, sinceDays: 7, now: NOW });
    // Snapshot-style asserts on structural anchors rather than the
    // entire string — keeps the test resilient to copy-edit churn but
    // catches structural regressions.
    expect(md).toContain('# DoR weekly digest');
    expect(md).toContain('**Window**: 2026-04-24 → 2026-05-01');
    expect(md).toContain('| Total issues evaluated | 16 |');
    expect(md).toContain('| Admit | 10 |');
    expect(md).toContain('| Needs-clarification | 4 |');
    expect(md).toContain('| Override | 2 |');
    expect(md).toContain('| Pass rate | 71.4% |');
    expect(md).toContain('## Top failing gates');
    expect(md).toContain('| 1 | `gate-2` | 3 |');
    expect(md).toContain('| 2 | `gate-5` | 2 |');
    expect(md).toContain('## False-positive trend');
    expect(md).toContain('| Current | 2 |');
    expect(md).toContain('| Prior | 1 |');
    expect(md).toContain('| Δ | +1 |');
    expect(md).toContain('Trend: +1 vs prior window');
  });

  it('renders a "no failing gates" message when the window is clean', () => {
    appendCalibrationEntry(
      { verdict: v({ issueId: 'clean' }), outcome: 'admit', author: 'alice' },
      { filePath: logPath, now: () => NOW },
    );
    const md = renderMarkdownDigest({ logPath, sinceDays: 7, now: NOW });
    expect(md).toContain('_No failing gates in this window._');
  });
});
