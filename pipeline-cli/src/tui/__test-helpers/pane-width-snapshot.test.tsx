/**
 * Width-pinned TUI snapshot tests — AISDLC-255.
 *
 * AC#2 + AC#3: for each top-level pane × each pinned width:
 *   (a) no line wider than the pinned width (measured by `string-width`)
 *   (b) outer border characters are present (border continuity)
 *   (c) title row contains the expected emoji + label text
 *
 * ## string-width v8 alignment with ink's layout engine
 *
 * `string-width` v8 now measures Unicode "Ambiguous" characters
 * (e.g. `▶` U+25B6, `⚙` U+2699, `🛤` U+1F6E4) as **1 column**, which
 * matches Ink v6's Yoga layout engine. Previously under string-width v7,
 * these characters were counted as 2 columns, producing false-positive
 * overflow reports: the assertNoOverflow() assertion would fire because
 * string-width saw N+1 visible columns while Ink had correctly rendered
 * the content into N columns.
 *
 * With v8 both measurements agree, so those false-positive overflow tests
 * have been flipped to `not.toThrow()`. The per-pane "known overflow"
 * tests below now document that the overflow was a v7 measurement artifact,
 * not a real layout defect.
 *
 * Panes without wide-char issues (all clean at 80/120/160):
 *   - Blockers pane: uses ✓/✗ (1-wide), row content doesn't use ▶
 *   - Events pane:   title uses 📡 but Ink's border absorbs the width
 *
 * Panes previously reported as overflowing (now clean under string-width v8):
 *   - PRs pane:          ▶ focus indicator in rows (any width)
 *   - Critical Path:     ▶ focus indicator in rows (any width)
 *   - Critical Path:     🛤 title (empty state)
 *   - Analytics:         ⚙ in PIPELINE THROUGHPUT heading (any width)
 *   - Config Browser:    ⚙ in CONFIGURATION title (any width)
 *
 * Note: The Critical Path title was previously `🛤️ CRITICAL PATH` (emoji +
 * U+FE0F variation selector). The variation selector is zero-width per
 * string-width but Ink v5 layout counted it as 1 extra cell, causing border
 * misalignment. AISDLC-259 stripped the VS: `🛤`. Under string-width v8
 * the bare `🛤` is now 1-wide (matching Ink's measurement), so the empty
 * state no longer overflows.
 *
 * Panes tested (AC#2):
 *   - PRs pane       (prs/pane.tsx)           — "📦 PRs IN FLIGHT"
 *   - Blockers pane  (panes/blockers.tsx)     — "🛑 / ✓ BLOCKERS"
 *   - Critical Path  (critical-path/pane.tsx) — "🛤 CRITICAL PATH"
 *   - Analytics      (panes/analytics.tsx)    — "👥 OPERATOR THROUGHPUT"
 *   - Events         (panes/events.tsx)       — "📡 EVENTS"
 *   - Config Browser (config-browser/pane.tsx)— "⚙ CONFIGURATION"
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

// Pane components
import { PrsPaneContent } from '../prs/pane.js';
import { buildPrRows } from '../prs/use-prs.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';

import { BlockersPane } from '../panes/blockers.js';
import type { BlockerItem } from '../blockers/detector.js';

import { CriticalPathPaneContent } from '../critical-path/pane.js';
import type { CriticalPathRow } from '../critical-path/use-critical-path.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';

import { AnalyticsPane } from '../panes/analytics.js';
import { EventsPane } from '../panes/events.js';
import { ConfigBrowserPane } from '../config-browser/pane.js';

import { cleanup, hasBorderRun, renderAtWidth } from './render-at-width.js';

afterEach(() => cleanup());

// ── Pinned widths ─────────────────────────────────────────────────────────────

const WIDTHS = [80, 120, 160] as const;

// ── Flush helper ──────────────────────────────────────────────────────────────

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ── Sample data factories ─────────────────────────────────────────────────────

function makePr(overrides: Partial<GhPrSummary> = {}): GhPrSummary {
  return {
    number: 42,
    title: 'feat: pipeline feature',
    state: 'open',
    url: 'https://github.com/org/repo/pull/42',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    headRefName: 'feat/new',
    mergeable: 'MERGEABLE',
    statusCheckRollup: 'SUCCESS',
    ...overrides,
  } as GhPrSummary;
}

function makeBlockerHookOpts(items: BlockerItem[]) {
  return {
    detector: () => items,
    taskWalker: () => ({ tasks: [], error: null }),
    prFetcher: () => ({ prs: [], error: null }),
    backlogIntervalMs: 1_000_000,
    prIntervalMs: 1_000_000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeSnapshotRecord(id: string, cpl = 0): SnapshotRecord {
  return {
    id,
    criticalPathLength: cpl,
    effectivePriority: 2,
    dependencies: [],
    dependents: [],
    lastModified: '2026-05-01T00:00:00Z',
  } as unknown as SnapshotRecord;
}

function makeCriticalPathRow(id: string, cpl = 0): CriticalPathRow {
  return {
    record: makeSnapshotRecord(id, cpl),
    effPri: 2,
    blastRadius: 1,
  };
}

function makeAnalyticsOpts() {
  return {
    decisionsReader: () => ({ records: [], error: null }),
    reliabilityReader: () => ({ available: false, thisWeek: 0, lastWeek: 0, delta: 0 }),
    tasks: [],
    events: [],
    now: () => new Date('2026-05-10T12:00:00Z'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ── PRs pane ──────────────────────────────────────────────────────────────────
//
// Under string-width v7, the PR row's ▶ focus indicator was counted as 2
// columns (vs. 1 in Ink layout), producing a false-positive overflow. Under
// string-width v8, ▶ is counted as 1 column — matching Ink — so the pane
// no longer overflows. The test below documents the v8 no-overflow behavior.

describe('PRs pane — width-pinned rendering (AC#2, AC#3)', () => {
  for (const width of WIDTHS) {
    describe(`at ${width} cols — empty state`, () => {
      it('(a) no line exceeds pinned width (empty state — no rows)', () => {
        // Empty state has no rows, so ▶ indicator and padEnd content
        // don't appear. This verifies the pane frame itself is clean.
        const result = renderAtWidth(<PrsPaneContent rows={[]} error={null} />, width);
        expect(() => result.assertNoOverflow()).not.toThrow();
      });

      it('(b) border characters present (border continuity)', () => {
        const result = renderAtWidth(<PrsPaneContent rows={[]} error={null} />, width);
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', () => {
        const result = renderAtWidth(<PrsPaneContent rows={[]} error={null} />, width);
        expect(result.lastFrame()).toContain('PRs IN FLIGHT');
      });
    });
  }

  it('PR rows with ▶ focus indicator — no overflow under string-width v8 (v7 false-positive resolved)', () => {
    // Under string-width v7, ▶ (U+25B6) was counted as 2 cols while Ink
    // measured it as 1 col, producing a false-positive overflow report.
    // Under string-width v8, ▶ is counted as 1 col — matching Ink's layout.
    const rows = buildPrRows([makePr()]);
    const result = renderAtWidth(<PrsPaneContent rows={rows} error={null} />, 80);
    expect(() => result.assertNoOverflow()).not.toThrow();
  });
});

// ── Blockers pane ─────────────────────────────────────────────────────────────
//
// Blockers pane uses ✓/✗ (1-wide) and text-only row items.
// The focus indicator is '> ' (plain ASCII). No wide-char overflow.

describe('Blockers pane — width-pinned rendering (AC#2, AC#3)', () => {
  const blocker: BlockerItem = {
    key: 'pr:42:changes-requested',
    kind: 'changes-requested',
    ref: '#42',
    summary: 'PR #42 has unaddressed CHANGES_REQUESTED',
    detail: 'Full detail text.',
    updatedAt: '2026-05-06T22:00:00Z',
    isUrgent: false,
  };

  for (const width of WIDTHS) {
    describe(`at ${width} cols`, () => {
      it('(a) no line exceeds pinned width', async () => {
        const result = renderAtWidth(
          <BlockersPane hookOpts={makeBlockerHookOpts([blocker])} />,
          width,
        );
        await flush();
        expect(() => result.assertNoOverflow()).not.toThrow();
      });

      it('(b) border characters present (border continuity)', async () => {
        const result = renderAtWidth(
          <BlockersPane hookOpts={makeBlockerHookOpts([blocker])} />,
          width,
        );
        await flush();
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', async () => {
        const result = renderAtWidth(
          <BlockersPane hookOpts={makeBlockerHookOpts([blocker])} />,
          width,
        );
        await flush();
        expect(result.lastFrame()).toContain('BLOCKERS');
      });
    });
  }
});

// ── Critical Path pane ────────────────────────────────────────────────────────
//
// Under string-width v7, rows using ▶ focus indicator (counted as 2 cols in
// v7, 1 col in Ink) caused false-positive overflow at ALL widths. Under
// string-width v8, ▶ is 1 col — matching Ink — so the overflow is gone.
// Border + title checks run at all widths.
//
// Fixed (AISDLC-259): the title emoji `🛤️` (U+1F6E4 + U+FE0F variation
// selector) was replaced with bare `🛤` (U+1F6E4). The variation selector
// caused Ink to allocate 1 extra cell, shifting the right border by 1 column
// and producing the doubled || artifact at the shared boundary in the overview
// layout. Under string-width v8, `🛤` is measured as 1 col (same as Ink),
// so the empty-state no longer overflows either.

describe('Critical Path pane — width-pinned rendering (AC#2, AC#3)', () => {
  const rows = [makeCriticalPathRow('AISDLC-100', 3), makeCriticalPathRow('AISDLC-101', 2)];
  const allRecords = rows.map((r) => r.record);

  for (const width of WIDTHS) {
    describe(`at ${width} cols`, () => {
      it('(b) border characters present (border continuity)', () => {
        const result = renderAtWidth(
          <CriticalPathPaneContent rows={rows} allRecords={allRecords} error={null} />,
          width,
        );
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', () => {
        const result = renderAtWidth(
          <CriticalPathPaneContent rows={rows} allRecords={allRecords} error={null} />,
          width,
        );
        expect(result.lastFrame()).toContain('CRITICAL PATH');
      });
    });
  }

  it('empty state — 🛤 title no longer overflows under string-width v8 (v7 false-positive resolved, AISDLC-524)', () => {
    const result = renderAtWidth(
      <CriticalPathPaneContent rows={[]} allRecords={[]} error={null} />,
      80,
    );
    // Under string-width v7, 🛤 (U+1F6E4) was counted as 2 cols while Ink's
    // Yoga layout measured it as 1 col, causing a false-positive 1-col
    // overflow in the empty state (AISDLC-524). Under string-width v8, 🛤
    // is measured as 1 col — matching Ink — so assertNoOverflow() passes.
    expect(() => result.assertNoOverflow()).not.toThrow();
  });

  it('rows with ▶ focus indicator — no overflow under string-width v8 (v7 false-positive resolved)', () => {
    const result = renderAtWidth(
      <CriticalPathPaneContent rows={rows} allRecords={allRecords} error={null} />,
      80,
    );
    // Under string-width v7, ▶ was 2 cols (vs. 1 col in Ink) → false-positive
    // overflow. Under string-width v8, ▶ is 1 col — matching Ink's layout.
    expect(() => result.assertNoOverflow()).not.toThrow();
  });
});

// ── Analytics pane ────────────────────────────────────────────────────────────
//
// Under string-width v7, ⚙ in PIPELINE THROUGHPUT heading was counted as
// 2 cols (vs. 1 col in Ink), causing a false-positive overflow at ALL widths.
// Under string-width v8, ⚙ is 1 col — matching Ink — so overflow is gone.

describe('Analytics pane — width-pinned rendering (AC#2, AC#3)', () => {
  for (const width of WIDTHS) {
    describe(`at ${width} cols`, () => {
      it('(b) border characters present (border continuity)', async () => {
        const result = renderAtWidth(<AnalyticsPane hookOpts={makeAnalyticsOpts()} />, width);
        await flush();
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', async () => {
        const result = renderAtWidth(<AnalyticsPane hookOpts={makeAnalyticsOpts()} />, width);
        await flush();
        expect(result.lastFrame()).toContain('OPERATOR THROUGHPUT');
      });
    });
  }

  it('⚙ in PIPELINE THROUGHPUT heading — no overflow under string-width v8 (v7 false-positive resolved)', async () => {
    const result = renderAtWidth(<AnalyticsPane hookOpts={makeAnalyticsOpts()} />, 80);
    await flush();
    // Under string-width v7, ⚙ was 2 cols (vs. 1 col in Ink) → false-positive
    // overflow. Under string-width v8, ⚙ is 1 col — matching Ink's layout.
    expect(() => result.assertNoOverflow()).not.toThrow();
  });
});

// ── Events pane ───────────────────────────────────────────────────────────────
//
// Events pane is clean: the 📡 emoji in the title is wide but Ink's border
// layout pads generously. At all three widths, the rendered lines stay within
// the pinned column count.

describe('Events pane — width-pinned rendering (AC#2, AC#3)', () => {
  for (const width of WIDTHS) {
    describe(`at ${width} cols`, () => {
      it('(a) no line exceeds pinned width', () => {
        const result = renderAtWidth(<EventsPane />, width);
        expect(() => result.assertNoOverflow()).not.toThrow();
      });

      it('(b) border characters present (border continuity)', () => {
        const result = renderAtWidth(<EventsPane />, width);
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', () => {
        const result = renderAtWidth(<EventsPane />, width);
        expect(result.lastFrame()).toContain('EVENTS');
      });
    });
  }
});

// ── Config Browser pane ───────────────────────────────────────────────────────
//
// Under string-width v7, ⚙ in CONFIGURATION title was counted as 2 cols
// (vs. 1 col in Ink), causing a false-positive overflow at ALL widths.
// Under string-width v8, ⚙ is 1 col — matching Ink — so overflow is gone.

describe('Config Browser pane — width-pinned rendering (AC#2, AC#3)', () => {
  /** Inject a no-op walker so we don't touch the filesystem. */
  const emptyWalker = () => ({ files: [], error: null });
  /**
   * Inject a no-op schema validator so the reference package dynamic-import
   * is never triggered in the test environment.
   */
  /** Returns null = no schema issues, matching the SchemaValidator return type. */
  const noopSchemaValidator = () => null;

  for (const width of WIDTHS) {
    describe(`at ${width} cols`, () => {
      it('(b) border characters present (border continuity)', async () => {
        const result = renderAtWidth(
          <ConfigBrowserPane walker={emptyWalker} schemaValidator={noopSchemaValidator} />,
          width,
        );
        await flush();
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', async () => {
        const result = renderAtWidth(
          <ConfigBrowserPane walker={emptyWalker} schemaValidator={noopSchemaValidator} />,
          width,
        );
        await flush();
        expect(result.lastFrame()).toContain('CONFIGURATION');
      });
    });
  }

  it('⚙ in CONFIGURATION title — no overflow under string-width v8 (v7 false-positive resolved)', async () => {
    const result = renderAtWidth(
      <ConfigBrowserPane walker={emptyWalker} schemaValidator={noopSchemaValidator} />,
      80,
    );
    await flush();
    // Under string-width v7, ⚙ was 2 cols (vs. 1 col in Ink) → false-positive
    // overflow. Under string-width v8, ⚙ is 1 col — matching Ink's layout.
    expect(() => result.assertNoOverflow()).not.toThrow();
  });
});
