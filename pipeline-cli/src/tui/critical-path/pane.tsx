/**
 * Critical Path pane (bottom-left) — RFC-0023 §7.3 / AISDLC-178.4.
 *
 * Renders the dispatch frontier sorted by effectivePriority + criticalPathLength.
 * Shows the next ~5–10 tasks the orchestrator would pick up.
 *
 * Per row: task ID, title (truncated), effPri, CPL, blast-radius.
 *
 * Keyboard:
 *   Enter  — open detail with ASCII dep tree (parents above, children below)
 *   ↑/↓    — move focus
 *   Escape — close detail view
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { CriticalPathRow } from './use-critical-path.js';
import { buildAsciiDepTree } from './use-critical-path.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';
import type { SourceErrorKind } from '../sources/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

// ── Detail view ───────────────────────────────────────────────────────────────

interface CriticalPathDetailProps {
  row: CriticalPathRow;
  allRecords: SnapshotRecord[];
  onClose: () => void;
}

export function CriticalPathDetail({
  row,
  allRecords,
  onClose,
}: CriticalPathDetailProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
    }
  });

  const treeLines = buildAsciiDepTree(row.record, allRecords);

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={1} flexGrow={1}>
      <Text bold color="yellow">
        🛤 Critical Path — {row.record.id}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          effPri: {row.effPri} CPL: {row.record.criticalPathLength} blast-radius: {row.blastRadius}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Dependency tree:</Text>
        {treeLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [Esc/q] close
        </Text>
      </Box>
    </Box>
  );
}

// ── Row component ─────────────────────────────────────────────────────────────

interface CriticalPathRowItemProps {
  row: CriticalPathRow;
  focused: boolean;
}

export function CriticalPathRowItem({
  row,
  focused,
}: CriticalPathRowItemProps): React.ReactElement {
  const record = row.record;
  // title comes from the record id (snapshot records don't carry title text)
  const idDisplay = truncate(record.id, 18);
  const prefix = focused ? '▶ ' : '  ';

  return (
    <Box>
      <Text color={row.blastRadius > 5 ? 'red' : row.blastRadius > 2 ? 'yellow' : 'white'}>
        {prefix}
        {idDisplay.padEnd(18)} effPri={row.effPri} CPL={record.criticalPathLength} blast=
        {row.blastRadius}
      </Text>
    </Box>
  );
}

// ── Pane component ────────────────────────────────────────────────────────────

/** Maximum number of rows to render (RFC §7.3: next ~5–10 tasks). */
export const CRITICAL_PATH_MAX_ROWS = 10;

export interface CriticalPathPaneContentProps {
  rows: CriticalPathRow[];
  allRecords: SnapshotRecord[];
  error: SourceErrorKind | null;
}

export function CriticalPathPaneContent({
  rows,
  allRecords,
  error,
}: CriticalPathPaneContentProps): React.ReactElement {
  const [focusIndex, setFocusIndex] = useState(0);
  const [detailRow, setDetailRow] = useState<CriticalPathRow | null>(null);
  const visibleRows = rows.slice(0, CRITICAL_PATH_MAX_ROWS);

  useInput((_input, key) => {
    if (detailRow) return;
    if (key.upArrow) {
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFocusIndex((i) => Math.min(visibleRows.length - 1, i + 1));
    } else if (key.return && visibleRows.length > 0) {
      setDetailRow(visibleRows[focusIndex] ?? null);
    }
  });

  if (detailRow) {
    return (
      <CriticalPathDetail
        row={detailRow}
        allRecords={allRecords}
        onClose={() => setDetailRow(null)}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="yellow">
        🛤 CRITICAL PATH ({rows.length} tasks)
      </Text>
      {error && (
        <Box marginTop={1}>
          <Text color="red">⚠ dep snapshot unavailable ({error})</Text>
        </Box>
      )}
      {rows.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            No dep snapshot found — run cli-deps snapshot first
          </Text>
        </Box>
      )}
      {visibleRows.map((row, i) => (
        <CriticalPathRowItem key={row.record.id} row={row} focused={i === focusIndex} />
      ))}
      {rows.length > CRITICAL_PATH_MAX_ROWS && (
        <Box>
          <Text color="gray" dimColor>
            … {rows.length - CRITICAL_PATH_MAX_ROWS} more tasks not shown
          </Text>
        </Box>
      )}
      {visibleRows.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            ↑↓ navigate Enter dep-tree detail
          </Text>
        </Box>
      )}
    </Box>
  );
}
