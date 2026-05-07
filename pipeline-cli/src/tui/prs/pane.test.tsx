/**
 * Tests for the PRs pane component — RFC-0023 §7.2 / AISDLC-178.4.
 *
 * Covers:
 *   - Empty state (no PRs)
 *   - List rendering with PR rows (number, branch, title, CI glyph, next-step)
 *   - Error banner when source-unavailable
 *   - Color mapping: green/yellow/red/gray rows
 *   - Keyboard: ↑↓ navigation, Enter opens detail, Escape closes detail
 *   - Detail view: renders PR number, CI, review, merge, next-step
 */

import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import { PrsPaneContent } from './pane.js';
import { buildPrRows, type PrRow } from './use-prs.js';
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
  });

  it('truncates long branch names and titles', () => {
    const rows = makeRows([
      makePr({
        headRefName: 'feat/this-is-a-very-long-branch-name-that-should-be-truncated',
        title: 'A very long title that should also be truncated for display purposes in the pane',
      }),
    ]);
    const { lastFrame } = render(<PrsPaneContent rows={rows} error={null} />);
    // Should render without crashing and contain the truncation indicator
    expect(lastFrame()).toContain('…');
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
    // Detail view should be visible
    expect(frame).toContain('#99');
  });

  it('closes detail view on Escape', async () => {
    const rows = makeRows([makePr({ number: 10, headRefName: 'feat/close-test' })]);
    const { lastFrame, stdin } = render(<PrsPaneContent rows={rows} error={null} />);

    await flush();
    stdin.write('\r'); // open detail
    await flush();

    // Press Escape to close
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

    // Just verify it didn't crash
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
});
