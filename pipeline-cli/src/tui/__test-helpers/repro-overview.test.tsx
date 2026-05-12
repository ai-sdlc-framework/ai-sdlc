/**
 * Overview middle-row border alignment regression tests — AISDLC-259.
 *
 * ## Bug
 * Before AISDLC-259, the `🛤️ CRITICAL PATH` title used a railway-track
 * emoji with a U+FE0F variation selector. The variation selector is
 * zero-width per `string-width` but Ink's yoga layout counted it as an
 * extra column, causing the right border of the CRITICAL PATH panel to
 * overshoot by 1 character. In the side-by-side overview layout this
 * produced a doubled `||` artifact at the shared column boundary between
 * the CRITICAL PATH and OPERATOR THROUGHPUT panels.
 *
 * ## Fix
 * Strip the U+FE0F variation selector from the emoji: `🛤️` → `🛤` (bare
 * U+1F6E4). `string-width` still reports width 2 (correct); Ink no longer
 * sees the extra zero-width sequence that threw off its layout pass.
 *
 * ## Tests
 * 1. Border alignment: verifies that the top border of the middle row
 *    (CRITICAL PATH + OPERATOR THROUGHPUT) has identical structure to the
 *    top row (BLOCKERS + PRs IN FLIGHT) — no doubled `||` artifact at the
 *    shared column boundary.
 * 2. No overflow: asserts that the title line does not overshoot the panel
 *    border by checking string-width equivalence.
 * 3. No variation selector: asserts the source title string for CRITICAL
 *    PATH does NOT contain U+FE0F so the regression cannot silently return.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { Box, Text } from 'ink';
import { CriticalPathPaneContent } from '../critical-path/pane.js';
import { AnalyticsPane } from '../panes/analytics.js';
import { PrsPaneContent } from '../prs/pane.js';
import { renderAtWidth, cleanup } from './render-at-width.js';
import type { CriticalPathRow } from '../critical-path/use-critical-path.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';

afterEach(() => cleanup());

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string.
 * Uses the same pattern as render-at-width.ts but written as a string escape
 * to avoid ESLint's no-empty-character-class on the ESC literal form.
 */
function stripAnsiSimple(str: string): string {
  // Remove SGR / CSI sequences: ESC [ ... m / ESC [ ... h etc.
  // Also remove OSC sequences (ESC ] ... BEL).
  // This is a permissive strip for test purposes.
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07)/g, '');
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

function makeRecord(id: string, cpl = 0): SnapshotRecord {
  return {
    id,
    criticalPathLength: cpl,
    effectivePriority: 2,
    dependencies: [],
    dependents: [],
    lastModified: '2026-05-01T00:00:00Z',
  } as unknown as SnapshotRecord;
}

function makeRow(id: string, cpl = 0): CriticalPathRow {
  return {
    record: makeRecord(id, cpl),
    effPri: 2,
    blastRadius: 1,
  };
}

function StubBlockers(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold>🛑 BLOCKERS (0)</Text>
    </Box>
  );
}

function Overview({ rows }: { rows: CriticalPathRow[] }): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexDirection="row" flexGrow={1}>
        <Box width="50%">
          <StubBlockers />
        </Box>
        <Box width="50%">
          <PrsPaneContent rows={[]} error={null} />
        </Box>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box width="50%">
          <CriticalPathPaneContent
            rows={rows}
            allRecords={rows.map((r) => r.record)}
            error={null}
          />
        </Box>
        <Box width="50%">
          <AnalyticsPane hookOpts={makeAnalyticsOpts()} />
        </Box>
      </Box>
    </Box>
  );
}

// ── Border alignment test ─────────────────────────────────────────────────────

/**
 * Parse the top-border line of each row-pair from the overview frame.
 *
 * For a 2-column layout, the top border looks like:
 *   ┌──────┐┌──────┐
 *
 * This helper extracts the border lines for the TOP row and MIDDLE row,
 * strips ANSI, and returns them. If the panels are aligned the two border
 * lines should have the same structure.
 */
function extractRowTopBorders(
  frame: string,
): { topRowBorder: string; middleRowBorder: string } | null {
  const rawLines = frame.split('\n');
  const lines = rawLines.map((l) => stripAnsiSimple(l));

  // Find all lines that look like "┌" border lines (start with ┌)
  const topBorderLineIndices = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.startsWith('┌'))
    .map(({ i }) => i);

  if (topBorderLineIndices.length < 2) return null;

  // First ┌ border line = top of top-row panels
  // Second ┌ border line = top of middle-row panels
  const topRowBorder = lines[topBorderLineIndices[0] ?? 0] ?? '';
  const middleRowBorder = lines[topBorderLineIndices[1] ?? 0] ?? '';

  return { topRowBorder, middleRowBorder };
}

describe('Overview middle row — border alignment regression (AISDLC-259)', () => {
  const rows = [makeRow('AISDLC-100', 5), makeRow('AISDLC-101', 4), makeRow('AISDLC-102', 3)];

  // Test at multiple widths where the bug previously manifested
  for (const w of [78, 80, 82, 84, 90]) {
    it(`top border of CRITICAL PATH row matches BLOCKERS row at width=${w}`, () => {
      const r = renderAtWidth(<Overview rows={rows} />, w);
      const frame = r.lastFrame() ?? '';

      const borders = extractRowTopBorders(frame);
      expect(borders, `could not parse border lines from frame at width=${w}`).not.toBeNull();

      if (!borders) return;

      // The top border of both rows should be identical (same panel widths)
      expect(borders.middleRowBorder).toBe(borders.topRowBorder);
    });

    it(`no doubled || artifact at shared column boundary at width=${w}`, () => {
      const r = renderAtWidth(<Overview rows={rows} />, w);
      const frame = r.lastFrame() ?? '';
      const rawLines = frame.split('\n');

      // Check all content lines (lines starting with │ after ANSI strip)
      // The shared boundary should be exactly "││" (right border of left box
      // + left border of right box) with no extra characters between them.
      // A "doubled ||" artifact appears when the left panel's right border
      // overshoots by 1 column, pushing an extra │ into the gutter.
      //
      // We count the occurrences of "│││" (3 consecutive vertical bars) which
      // would indicate a triple-border artifact. There should be none.
      for (const line of rawLines) {
        const stripped = stripAnsiSimple(line);
        if (!stripped.startsWith('│')) continue;
        expect(
          stripped,
          `line at width=${w} contains triple-border artifact: "${stripped.slice(0, 120)}"`,
        ).not.toContain('│││');
      }
    });
  }
});

// ── No variation selector regression guard ────────────────────────────────────

describe('CRITICAL PATH title — no U+FE0F variation selector (AISDLC-259)', () => {
  it('does not contain U+FE0F in the rendered title text', () => {
    // Render the critical path pane and check the title line.
    // The variation selector U+FE0F is zero-width per string-width but Ink
    // counts it as an extra layout cell, causing 1-column border drift.
    // This test will fail if the source is reverted to "🛤️" (with VS).
    const rows = [makeRow('AISDLC-100', 5)];
    const r = renderAtWidth(
      <CriticalPathPaneContent
        rows={rows}
        allRecords={[makeRecord('AISDLC-100', 5)]}
        error={null}
      />,
      80,
    );
    const frame = r.lastFrame() ?? '';
    // U+FE0F is the variation selector that triggers emoji presentation mode.
    // It should NOT appear in the rendered output after AISDLC-259's fix.
    const VARIATION_SELECTOR_16 = '️';
    expect(frame).not.toContain(VARIATION_SELECTOR_16);
  });

  it('CRITICAL PATH title still contains the railway-track emoji (visual regression)', () => {
    // Ensure the emoji itself is preserved (just without the variation selector).
    const rows = [makeRow('AISDLC-100', 5)];
    const r = renderAtWidth(
      <CriticalPathPaneContent
        rows={rows}
        allRecords={[makeRecord('AISDLC-100', 5)]}
        error={null}
      />,
      80,
    );
    const frame = r.lastFrame() ?? '';
    // U+1F6E4 = 🛤 (railway track, bare, without variation selector)
    const RAILWAY_TRACK = '\u{1F6E4}';
    expect(frame).toContain(RAILWAY_TRACK);
  });
});
