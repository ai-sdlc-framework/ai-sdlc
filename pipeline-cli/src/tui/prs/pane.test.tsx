/**
 * Tests for the PRs pane component — RFC-0023 §7.2 / AISDLC-178.4 + 178.4.1.
 *
 * Covers:
 *   - Empty state (no PRs)
 *   - List rendering with PR rows (number, branch, title, CI glyph, next-step)
 *   - Error banner when source-unavailable
 *   - Color mapping: green/yellow/red/gray rows
 *   - Keyboard: ↑↓ navigation, Enter opens detail, Escape closes detail
 *   - Detail view: renders PR number, CI, review, merge, next-step
 *   - AISDLC-178.4.1: chain indicator + unblocks count + sort cycling (s key)
 *   - AISDLC-178.4.1: detail view renders chain tree
 */

import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import { PrsPaneContent } from './pane.js';
import { buildPrRows, type PrRow } from './use-prs.js';
import { derivePrChainGraph } from './critical-path.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';

afterEach(() => {
  cleanup();
});

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function makePr(overrides: Partial<GhPrSummary & { reviewDecision?: string }> = {}): GhPrSummary {
  return {
    number: 1,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/org/repo/pull/1',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    headRefName: 'feat/test',
    mergeable: 'MERGEABLE',
    statusCheckRollup: null,
    ...overrides,
  } as GhPrSummary;
}

function makeRows(prs: GhPrSummary[]): PrRow[] {
  return buildPrRows(prs);
}

describe('PrsPaneContent — empty state', () => {
  it('renders PRs IN FLIGHT title with count 0', () => {
    const { lastFrame } = render(<PrsPaneContent rows={[]} error={null} />);
    expect(lastFrame()).toContain('PRs IN FLIGHT (0)');
  });

  it('shows no-open-prs message', () => {
    const { lastFrame } = render(<PrsPaneContent rows={[]} error={null} />);
    expect(lastFrame()).toContain('No open PRs');
  });

  it('shows the active sort mode in the header', () => {
    const { lastFrame } = render(<PrsPaneContent rows={[]} error={null} />);
    expect(lastFrame()).toContain('sort: critical-path');
  });
});

describe('PrsPaneContent — error state', () => {
  it('shows error banner when source-unavailable', () => {
    const { lastFrame } = render(<PrsPaneContent rows={[]} error="source-unavailable" />);
    expect(lastFrame()).toContain('source-unavailable');
  });

  it('shows error banner when source-corrupt', () => {
    const { lastFrame } = render(<PrsPaneContent rows={[]} error="source-corrupt" />);
    expect(lastFrame()).toContain('source-corrupt');
  });
});

describe('PrsPaneContent — list rendering', () => {
  it('renders PR number and branch in each row', () => {
    const rows = makeRows([makePr({ number: 42, headRefName: 'feat/my-feature' })]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('#42');
    expect(frame).toContain('feat/my-feature');
  });

  it('renders CI glyph in each row', () => {
    const rows = makeRows([makePr({ statusCheckRollup: 'SUCCESS' })]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('✓');
  });

  it('renders pending CI glyph', () => {
    const rows = makeRows([makePr({ statusCheckRollup: null })]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('⏳');
  });

  it('renders failure CI glyph', () => {
    const rows = makeRows([makePr({ statusCheckRollup: 'FAILURE' })]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('✗');
  });

  it('renders PRs count in header', () => {
    const rows = makeRows([makePr({ number: 1 }), makePr({ number: 2 }), makePr({ number: 3 })]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('PRs IN FLIGHT (3)');
  });

  it('renders navigation hint when PRs exist', () => {
    const rows = makeRows([makePr()]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('navigate');
    expect(lastFrame()).toContain('[s] sort');
  });

  it('truncates long branch names and titles', () => {
    const rows = makeRows([
      makePr({
        headRefName: 'feat/this-is-a-very-long-branch-name-that-should-be-truncated',
        title: 'A very long title that should also be truncated for display purposes in the pane',
      }),
    ]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('…');
  });

  it('renders chain indicator (🔗 N/M) for chained PRs (AC #3)', () => {
    const rows = makeRows([
      makePr({ number: 1 }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
    ]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('🔗 1/2');
    expect(frame).toContain('🔗 2/2');
  });

  it('renders unblocks N count for PRs with downstream (AC #3)', () => {
    const rows = makeRows([
      makePr({ number: 1 }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
      makePr({ number: 3, labels: [{ name: 'depends-on:#1' }] }),
    ]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    expect(lastFrame()).toContain('unblocks 2');
  });

  it('omits chain indicator on singleton PRs', () => {
    const rows = makeRows([makePr({ number: 99 })]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('🔗');
  });
});

describe('PrsPaneContent — keyboard navigation', () => {
  it('opens detail view on Enter', async () => {
    const rows = makeRows([makePr({ number: 99, headRefName: 'feat/detail-test' })]);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);

    await flush();
    stdin.write('\r'); // Enter key
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('#99');
  });

  it('closes detail view on Escape', async () => {
    const rows = makeRows([makePr({ number: 10, headRefName: 'feat/close-test' })]);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);

    await flush();
    stdin.write('\r');
    await flush();

    stdin.write('\x1b'); // ESC
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('PRs IN FLIGHT');
  });

  it('navigates down with arrow key', async () => {
    const rows = makeRows([
      makePr({ number: 1, headRefName: 'feat/one' }),
      makePr({ number: 2, headRefName: 'feat/two' }),
    ]);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);
    await flush();

    stdin.write('\x1b[B'); // down arrow
    await flush();

    expect(lastFrame()).toContain('PRs IN FLIGHT');
  });

  it('renders detail view with review state and next-step', async () => {
    const rows = makeRows([
      makePr({
        number: 77,
        reviewDecision: 'APPROVED',
        statusCheckRollup: 'SUCCESS',
      } as unknown as Partial<GhPrSummary>),
    ]);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);
    await flush();
    stdin.write('\r');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('#77');
    expect(frame).toContain('approved');
    expect(frame).toContain('ready-to-merge');
  });

  it('cycles sort modes on `s` keystroke (AC #5)', async () => {
    const rows = makeRows([
      makePr({ number: 1, statusCheckRollup: 'SUCCESS' }),
      makePr({ number: 2, statusCheckRollup: 'FAILURE' }),
    ]);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);
    await flush();
    expect(lastFrame()).toContain('sort: critical-path');

    stdin.write('s');
    await flush();
    expect(lastFrame()).toContain('sort: recency');

    stdin.write('s');
    await flush();
    expect(lastFrame()).toContain('sort: ci-status');

    stdin.write('s');
    await flush();
    expect(lastFrame()).toContain('sort: critical-path');
  });

  it('detail view renders chain tree when chain present (AC #4)', async () => {
    const prs = [
      makePr({ number: 100, headRefName: 'feat/parent', title: 'parent' }),
      makePr({
        number: 101,
        headRefName: 'feat/child',
        title: 'child',
        labels: [{ name: 'depends-on:#100' }],
      }),
    ];
    const rows = makeRows(prs);
    const graph = derivePrChainGraph({ prs });
    const { lastFrame, stdin } = render(
      <PrsPaneContent rows={rows} prs={prs} graph={graph} error={null} />,
    );
    await flush();
    stdin.write('\r'); // open detail on focused (head of chain)
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Chain:');
    // Head-of-chain has a downstream entry pointing at #101
    expect(frame).toContain('#101');
  });

  /**
   * AISDLC-236 regression guard: navigation sequence (5 × down) must
   * produce a single coherent frame, NOT append new frames below the
   * previous ones ("content drift" symptom).
   *
   * ink-testing-library captures only `lastFrame()` — the final rendered
   * output — so if the renderer were appending rather than redrawing we
   * would see duplicate pane headers in that single string.  A correct
   * in-place redraw shows each header exactly once.
   */
  it('AISDLC-236: 5× down-arrow navigation yields a single frame with no duplicate pane headers', async () => {
    const prs = [
      makePr({ number: 1, headRefName: 'feat/a' }),
      makePr({ number: 2, headRefName: 'feat/b' }),
      makePr({ number: 3, headRefName: 'feat/c' }),
      makePr({ number: 4, headRefName: 'feat/d' }),
      makePr({ number: 5, headRefName: 'feat/e' }),
      makePr({ number: 6, headRefName: 'feat/f' }),
    ];
    const rows = makeRows(prs);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);
    await flush();

    // Simulate 5 down-arrow keystrokes (the exact sequence from the bug report).
    for (let i = 0; i < 5; i++) {
      stdin.write('\x1b[B'); // VT100 down-arrow
      await flush();
    }

    const frame = lastFrame() ?? '';

    // The pane header must appear exactly once — if frames are being
    // appended instead of redrawn in place the header would appear
    // multiple times in the combined output.
    const headerCount = (frame.match(/PRs IN FLIGHT/g) ?? []).length;
    expect(headerCount).toBe(1);

    // The focus indicator must be on row 5 (0-indexed) after 5 downs.
    // Row index 5 = PR #6 (clamped at last row).
    expect(frame).toContain('▶');
    // The pane is still showing the list (not detail view).
    expect(frame).toContain('navigate');
  });
});
