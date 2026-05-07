/**
 * PRs pane (top-right) — RFC-0023 §7.2 / AISDLC-178.4.
 *
 * Renders every open PR with: number, branch (truncated), title (truncated),
 * CI glyph (✓/⏳/✗), review state, merge state, next-step annotation.
 * Color-coded by urgency. Sorted by operator-attention required descending.
 *
 * Keyboard:
 *   Enter — open detail view for focused row (full title/body, review history)
 *   `o`   — `gh browse <number>` in browser
 *   ↑/↓   — move focus
 *   Escape — close detail view
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { PrRow, UrgencyColor } from './use-prs.js';
import type { SourceErrorKind } from '../sources/types.js';
import { execFileSync } from 'node:child_process';

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function colorFor(color: UrgencyColor): string {
  switch (color) {
    case 'green':
      return 'green';
    case 'yellow':
      return 'yellow';
    case 'red':
      return 'red';
    case 'gray':
    default:
      return 'gray';
  }
}

// ── Detail view ───────────────────────────────────────────────────────────────

interface PrDetailProps {
  row: PrRow;
  onClose: () => void;
}

export function PrDetail({ row, onClose }: PrDetailProps): React.ReactElement {
  const pr = row.pr;
  const body = (pr as unknown as { body?: string }).body ?? '';

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
    }
    if (input === 'o') {
      try {
        execFileSync('gh', ['browse', String(pr.number)], { stdio: 'ignore' });
      } catch {
        // Best-effort — gh may not be installed or may fail silently.
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={1} flexGrow={1}>
      <Text bold color={colorFor(row.color)}>
        PR #{pr.number} — {pr.headRefName ?? 'unknown-branch'}
      </Text>
      <Text color="gray">─────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold>{pr.title}</Text>
      </Box>
      {body && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Body:</Text>
          <Text>{truncate(body, 500)}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">CI: </Text>
        <Text>{row.ci}</Text>
        <Text color="gray">Review: </Text>
        <Text>{row.review}</Text>
        <Text color="gray">Merge: </Text>
        <Text>{row.merge}</Text>
        <Text color="gray">Next: </Text>
        <Text color={colorFor(row.color)}>{row.nextStep}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [Esc/q] close [o] open in browser
        </Text>
      </Box>
    </Box>
  );
}

// ── Row component ─────────────────────────────────────────────────────────────

interface PrRowItemProps {
  row: PrRow;
  focused: boolean;
}

export function PrRowItem({ row, focused }: PrRowItemProps): React.ReactElement {
  const pr = row.pr;
  const branch = truncate(pr.headRefName ?? '', 20);
  const title = truncate(pr.title, 35);
  const prefix = focused ? '▶ ' : '  ';
  const color = colorFor(row.color);

  return (
    <Box>
      <Text color={color}>
        {prefix}#{pr.number} {branch.padEnd(20)} {row.ci} {title.padEnd(35)} {row.review.padEnd(18)}{' '}
        {row.merge.padEnd(7)} {row.nextStep}
      </Text>
    </Box>
  );
}

// ── Pane component ────────────────────────────────────────────────────────────

export interface PrsPaneProps {
  rows: PrRow[];
  error: SourceErrorKind | null;
  /** Injected runner for `gh browse` (tests). Defaults to execFileSync. */
  browseRunner?: (num: number) => void;
}

/**
 * PRs pane — renders list view or (when Enter pressed) detail view.
 * Exported separately from the default App wiring so tests can inject rows.
 */
export function PrsPaneContent({ rows, error }: PrsPaneProps): React.ReactElement {
  const [focusIndex, setFocusIndex] = useState(0);
  const [detailPr, setDetailPr] = useState<PrRow | null>(null);

  useInput((input, key) => {
    if (detailPr) return; // detail view handles its own input
    if (key.upArrow) {
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFocusIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (key.return && rows.length > 0) {
      setDetailPr(rows[focusIndex] ?? null);
    } else if (input === 'o' && rows.length > 0) {
      const focused = rows[focusIndex];
      if (focused) {
        try {
          execFileSync('gh', ['browse', String(focused.pr.number)], { stdio: 'ignore' });
        } catch {
          // Best-effort.
        }
      }
    }
  });

  if (detailPr) {
    return <PrDetail row={detailPr} onClose={() => setDetailPr(null)} />;
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        📦 PRs IN FLIGHT ({rows.length})
      </Text>
      <Text color="gray">─────────────────────────────────────────────────────────────</Text>
      {error && (
        <Box marginTop={1}>
          <Text color="red">⚠ source-unavailable: gh pr list failed ({error})</Text>
        </Box>
      )}
      {rows.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="green">✓ No open PRs</Text>
        </Box>
      )}
      {rows.map((row, i) => (
        <PrRowItem key={row.pr.number} row={row} focused={i === focusIndex} />
      ))}
      {rows.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            ↑↓ navigate Enter detail [o] browse
          </Text>
        </Box>
      )}
    </Box>
  );
}
