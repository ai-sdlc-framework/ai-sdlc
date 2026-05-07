/**
 * PRs pane (top-right) — RFC-0023 §7.2 / AISDLC-178.4 + AISDLC-178.4.1.
 *
 * Renders every open PR with: number, branch (truncated), title (truncated),
 * CI glyph (✓/⏳/✗), review state, merge state, next-step annotation, plus
 * AISDLC-178.4.1's chain indicator (`🔗 N/M` when part of a serial chain)
 * and `unblocks N` count. Sorted by critical-path-length DESC by default
 * so the head-of-chain PR (the one to merge first) surfaces at the top.
 *
 * Keyboard:
 *   Enter — open detail view (chain tree + full title/body, review history)
 *   `o`   — `gh browse <number>` in browser
 *   `s`   — cycle sort mode: critical-path → recency → ci-status → critical-path
 *   ↑/↓   — move focus
 *   Escape — close detail view
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import {
  nextSortMode,
  sortPrRows,
  type PrRow,
  type PrSortMode,
  type UrgencyColor,
} from './use-prs.js';
import { buildPrChainTree, type PrChainGraph } from './critical-path.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';
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

function chainIndicator(row: PrRow): string {
  if (!row.chain.inChain) return '';
  return `🔗 ${row.chain.chainPos}/${row.chain.chainLen}`;
}

function unblocksLabel(row: PrRow): string {
  return row.chain.unblockCount > 0 ? `unblocks ${row.chain.unblockCount}` : '';
}

const SORT_LABEL: Readonly<Record<PrSortMode, string>> = {
  'critical-path': 'critical-path',
  recency: 'recency',
  'ci-status': 'ci-status',
};

// ── Detail view ───────────────────────────────────────────────────────────────

interface PrDetailProps {
  row: PrRow;
  prs: GhPrSummary[];
  graph: PrChainGraph;
  onClose: () => void;
}

export function PrDetail({ row, prs, graph, onClose }: PrDetailProps): React.ReactElement {
  const pr = row.pr;
  const body = pr.body ?? '';
  const treeLines = buildPrChainTree({ prNumber: pr.number, prs, graph });

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
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Chain:</Text>
        {treeLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
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
  const title = truncate(pr.title, 30);
  const prefix = focused ? '▶ ' : '  ';
  const color = colorFor(row.color);
  const chainTag = chainIndicator(row);
  const unblocks = unblocksLabel(row);

  return (
    <Box>
      <Text color={color}>
        {prefix}#{pr.number} {branch.padEnd(20)} {row.ci} {title.padEnd(30)} {row.review.padEnd(18)}{' '}
        {row.merge.padEnd(7)} {row.nextStep.padEnd(15)} {chainTag.padEnd(10)} {unblocks}
      </Text>
    </Box>
  );
}

// ── Pane component ────────────────────────────────────────────────────────────

export interface PrsPaneProps {
  rows: PrRow[];
  prs?: GhPrSummary[];
  graph?: PrChainGraph;
  error: SourceErrorKind | null;
  /** Injected runner for `gh browse` (tests). Defaults to execFileSync. */
  browseRunner?: (num: number) => void;
}

/**
 * PRs pane — renders list view or (when Enter pressed) detail view.
 * Exported separately from the default App wiring so tests can inject rows.
 *
 * The pane manages its own `sortMode` state: rows arrive sorted by
 * `critical-path` (the hook default) and the `s` keystroke re-sorts them
 * locally without re-fetching.
 */
export function PrsPaneContent({ rows, prs, graph, error }: PrsPaneProps): React.ReactElement {
  const [focusIndex, setFocusIndex] = useState(0);
  const [detailPr, setDetailPr] = useState<PrRow | null>(null);
  const [sortMode, setSortMode] = useState<PrSortMode>('critical-path');

  const visibleRows = sortPrRows(rows, sortMode);
  const allPrs: GhPrSummary[] = prs ?? rows.map((r) => r.pr);

  useInput((input, key) => {
    if (detailPr) return; // detail view handles its own input
    if (key.upArrow) {
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFocusIndex((i) => Math.min(visibleRows.length - 1, i + 1));
    } else if (key.return && visibleRows.length > 0) {
      setDetailPr(visibleRows[focusIndex] ?? null);
    } else if (input === 'o' && visibleRows.length > 0) {
      const focused = visibleRows[focusIndex];
      if (focused) {
        try {
          execFileSync('gh', ['browse', String(focused.pr.number)], { stdio: 'ignore' });
        } catch {
          // Best-effort.
        }
      }
    } else if (input === 's') {
      setSortMode((m) => nextSortMode(m));
      setFocusIndex(0);
    }
  });

  if (detailPr) {
    // Best-effort graph: if the App didn't pass one, derive a singleton-only
    // graph stub so the detail view still renders without crashing.
    const detailGraph: PrChainGraph = graph ?? {
      info: new Map(rows.map((r) => [r.pr.number, r.chain])),
      upstreamMap: new Map(),
      downstreamMap: new Map(),
    };
    return (
      <PrDetail row={detailPr} prs={allPrs} graph={detailGraph} onClose={() => setDetailPr(null)} />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        📦 PRs IN FLIGHT ({visibleRows.length}) — sort: {SORT_LABEL[sortMode]}
      </Text>
      <Text color="gray">─────────────────────────────────────────────────────────────</Text>
      {error && (
        <Box marginTop={1}>
          <Text color="red">⚠ source-unavailable: gh pr list failed ({error})</Text>
        </Box>
      )}
      {visibleRows.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="green">✓ No open PRs</Text>
        </Box>
      )}
      {visibleRows.map((row, i) => (
        <PrRowItem key={row.pr.number} row={row} focused={i === focusIndex} />
      ))}
      {visibleRows.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            ↑↓ navigate Enter detail [o] browse [s] sort
          </Text>
        </Box>
      )}
    </Box>
  );
}
