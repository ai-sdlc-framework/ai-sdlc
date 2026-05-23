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
  shouldIncludeCriticalPath,
} from './slack-digest.js';
import { writeSnapshot } from '../deps/snapshot.js';
import { writeTaskFile, makeTmpProject, cleanupTmpProject } from '../__test-helpers/make-task.js';
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
  // AISDLC-410: post-cutover DEPS_COMPOSITION defaults ON, so the critical-path
  // section auto-appends to digests. These base-shape tests opt-out so they
  // exercise the original 3-block render; the critical-path-section tests
  // below already explicitly set includeCriticalPath.
  let priorDeps: string | undefined;
  beforeEach(() => {
    priorDeps = process.env.AI_SDLC_DEPS_COMPOSITION;
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
  });
  afterEach(() => {
    if (priorDeps === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
    else process.env.AI_SDLC_DEPS_COMPOSITION = priorDeps;
  });

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

describe('shouldIncludeCriticalPath (RFC-0014 Phase 4)', () => {
  let priorEnv: string | undefined;
  beforeEach(() => {
    priorEnv = process.env.AI_SDLC_DEPS_COMPOSITION;
    delete process.env.AI_SDLC_DEPS_COMPOSITION;
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
    else process.env.AI_SDLC_DEPS_COMPOSITION = priorEnv;
  });

  it('returns explicit opt when set, ignoring env', () => {
    process.env.AI_SDLC_DEPS_COMPOSITION = '0';
    expect(shouldIncludeCriticalPath({ includeCriticalPath: true })).toBe(true);
    process.env.AI_SDLC_DEPS_COMPOSITION = '1';
    expect(shouldIncludeCriticalPath({ includeCriticalPath: false })).toBe(false);
  });

  it('falls back to AI_SDLC_DEPS_COMPOSITION when no explicit opt (post-AISDLC-410 default-ON)', () => {
    // Pre-AISDLC-410: unset env = OFF. Post-AISDLC-410: unset env = ON
    // (operator promotion via override-path); '0' / 'off' is the opt-out.
    process.env.AI_SDLC_DEPS_COMPOSITION = '1';
    expect(shouldIncludeCriticalPath()).toBe(true);
    process.env.AI_SDLC_DEPS_COMPOSITION = '0';
    expect(shouldIncludeCriticalPath()).toBe(false);
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
    expect(shouldIncludeCriticalPath()).toBe(false);
    delete process.env.AI_SDLC_DEPS_COMPOSITION;
    expect(shouldIncludeCriticalPath()).toBe(true);
  });
});

describe('buildWeeklyDigest — RFC-0014 Phase 4 critical-path section', () => {
  let project: string;
  let projectArtifactsDir: string;
  let priorComposition: string | undefined;

  beforeEach(() => {
    project = makeTmpProject();
    projectArtifactsDir = join(project, 'artifacts');
    priorComposition = process.env.AI_SDLC_DEPS_COMPOSITION;
    process.env.AI_SDLC_DEPS_COMPOSITION = '1';
  });

  afterEach(() => {
    cleanupTmpProject(project);
    if (priorComposition === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
    else process.env.AI_SDLC_DEPS_COMPOSITION = priorComposition;
  });

  function seedSnapshot(): void {
    writeTaskFile(project, { id: 'AISDLC-A', title: 'A root', priority: 'medium' });
    writeTaskFile(project, {
      id: 'AISDLC-B',
      title: 'B mid',
      priority: 'medium',
      dependencies: ['AISDLC-A'],
    });
    writeTaskFile(project, {
      id: 'AISDLC-C',
      title: 'C leaf',
      priority: 'critical',
      dependencies: ['AISDLC-B'],
    });
    writeSnapshot('rolling', { workDir: project, artifactsDir: projectArtifactsDir });
  }

  it('OFF by default — digest payload matches the pre-RFC-0014 baseline (AC #6)', () => {
    seedSnapshot();
    const digest = buildWeeklyDigest({
      logPath,
      sinceDays: 7,
      now: NOW,
      includeCriticalPath: false,
    });
    expect(digest.blocks).toHaveLength(3);
    expect(digest.fallbackText).not.toContain('critical path');
  });

  it('ON — appends a "🛤️ Critical Path" Slack section after the divider (AC #1)', () => {
    seedSnapshot();
    const digest = buildWeeklyDigest({
      logPath,
      sinceDays: 7,
      now: NOW,
      includeCriticalPath: true,
      criticalPathOpts: { workDir: project, artifactsDir: projectArtifactsDir, limit: 5 },
    });
    // Header (1) + metrics (1) + divider (1) + critical-path section (1) +
    // critical-path divider (1) = 5 blocks.
    expect(digest.blocks.length).toBeGreaterThanOrEqual(4);
    const cpBlock = digest.blocks[3] as { type: string; text: { type: string; text: string } };
    expect(cpBlock.type).toBe('section');
    expect(cpBlock.text.text).toContain('🛤️ Critical Path');
    expect(cpBlock.text.text).toContain('AISDLC-A');
    expect(digest.fallbackText).toContain('critical path top');
    expect(digest.fallbackText).toContain('AISDLC-A');
  });

  it('ON + empty graph — section is omitted entirely (AC #2)', () => {
    // Composition flag is on AND a snapshot exists, but the graph is all
    // isolated leaves so selectCriticalPath returns 0 items.
    writeTaskFile(project, { id: 'AISDLC-A', title: 'isolated', priority: 'medium' });
    writeSnapshot('rolling', { workDir: project, artifactsDir: projectArtifactsDir });
    const digest = buildWeeklyDigest({
      logPath,
      sinceDays: 7,
      now: NOW,
      includeCriticalPath: true,
      criticalPathOpts: { workDir: project, artifactsDir: projectArtifactsDir },
    });
    expect(digest.blocks).toHaveLength(3);
    expect(digest.fallbackText).not.toContain('critical path');
  });

  it('ON + no snapshot — surfaces the "insufficient data" hint by default', () => {
    const digest = buildWeeklyDigest({
      logPath,
      sinceDays: 7,
      now: NOW,
      includeCriticalPath: true,
      criticalPathOpts: { workDir: project, artifactsDir: projectArtifactsDir },
    });
    // Hint is rendered as 2 extra blocks (header + divider) so the digest
    // length grows past the baseline 3.
    expect(digest.blocks.length).toBeGreaterThan(3);
    const hintBlock = digest.blocks[3] as { type: string; text: { type: string; text: string } };
    expect(hintBlock.text.text).toContain('insufficient data');
    expect(hintBlock.text.text).toContain('cli-deps snapshot');
  });
});

describe('renderMarkdownDigest — RFC-0014 Phase 4', () => {
  let project: string;
  let projectArtifactsDir: string;
  let priorComposition: string | undefined;

  beforeEach(() => {
    project = makeTmpProject();
    projectArtifactsDir = join(project, 'artifacts');
    priorComposition = process.env.AI_SDLC_DEPS_COMPOSITION;
    process.env.AI_SDLC_DEPS_COMPOSITION = '1';
  });
  afterEach(() => {
    cleanupTmpProject(project);
    if (priorComposition === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
    else process.env.AI_SDLC_DEPS_COMPOSITION = priorComposition;
  });

  it('appends the Critical Path section when includeCriticalPath=true', () => {
    writeTaskFile(project, { id: 'AISDLC-A', title: 'A root', priority: 'medium' });
    writeTaskFile(project, {
      id: 'AISDLC-B',
      title: 'B leaf',
      priority: 'critical',
      dependencies: ['AISDLC-A'],
    });
    writeSnapshot('rolling', { workDir: project, artifactsDir: projectArtifactsDir });
    const md = renderMarkdownDigest({
      logPath,
      sinceDays: 7,
      now: NOW,
      includeCriticalPath: true,
      criticalPathOpts: { workDir: project, artifactsDir: projectArtifactsDir },
    });
    expect(md).toContain('## 🛤️ Critical Path');
    expect(md).toContain('**AISDLC-A**');
  });

  it('does NOT append the section when includeCriticalPath=false', () => {
    const md = renderMarkdownDigest({
      logPath,
      sinceDays: 7,
      now: NOW,
      includeCriticalPath: false,
    });
    expect(md).not.toContain('Critical Path');
  });
});
