/**
 * Dependency-graph full-screen mode — RFC-0023 §7.6 / AISDLC-178.5.
 *
 * The `d` keystroke zooms to a full-screen ASCII rendering of the entire
 * dep graph (not just the dispatch frontier). Reuses `useCriticalPath`
 * for snapshot fetching + `buildAsciiDepTree` for tree rendering.
 *
 * Navigation: ↑/↓ moves the focused root; Enter expands a sub-tree (via
 * the existing CriticalPathDetail under the hood). Esc returns to overview.
 *
 * For v1 the rendering is "every record's tree section concatenated"
 * subject to a fixed line cap so a 200-task graph doesn't overwhelm the
 * terminal. Operators with larger graphs use `cli-deps inspect`.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { useCriticalPath, buildAsciiDepTree } from '../critical-path/use-critical-path.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';

export const DEPS_FULL_LINE_CAP = 200;

interface DepsFullProps {
  /** Inject pre-built rows (tests). */
  rows?: { record: SnapshotRecord }[];
  /** Inject all records (tests). */
  allRecords?: SnapshotRecord[];
  /** Optional filter (search). */
  filterQuery?: string | null;
}

export function DepsFullScreen(props: DepsFullProps): React.ReactElement {
  // Real path: hook fetches; tests path: props inject.
  const live = useCriticalPath();
  const rows = props.rows ?? live.rows;
  const allRecords = props.allRecords ?? live.allRecords;
  const error = live.error;

  const filtered = props.filterQuery
    ? rows.filter((r) => r.record.id.toLowerCase().includes(props.filterQuery!.toLowerCase()))
    : rows;

  const [focusIdx, setFocusIdx] = useState(0);
  const clamped = Math.min(focusIdx, Math.max(0, filtered.length - 1));

  useInput((_input, key) => {
    if (key.upArrow) setFocusIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
  });

  // Render: list each record + its small tree, capped at DEPS_FULL_LINE_CAP lines.
  const treeBlocks: { id: string; lines: string[] }[] = [];
  let totalLines = 0;
  for (const r of filtered) {
    const lines = buildAsciiDepTree(r.record, allRecords);
    treeBlocks.push({ id: r.record.id, lines });
    totalLines += lines.length + 2;
    if (totalLines >= DEPS_FULL_LINE_CAP) break;
  }
  const truncated = totalLines >= DEPS_FULL_LINE_CAP && filtered.length > treeBlocks.length;

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={1} flexGrow={1}>
      <Text bold color="yellow">
        🛤️ DEPENDENCY GRAPH ({filtered.length} tasks)
      </Text>
      <Text color="gray">─────────────────────────────────────────────────────────</Text>
      {error && (
        <Box marginTop={1}>
          <Text color="red">⚠ dep snapshot unavailable ({error})</Text>
        </Box>
      )}
      {filtered.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            {rows.length === 0
              ? 'No dep snapshot found — run cli-deps snapshot first'
              : `No tasks match "${props.filterQuery}"`}
          </Text>
        </Box>
      )}
      {filtered.map((row, i) => {
        const focused = i === clamped;
        const block = treeBlocks.find((b) => b.id === row.record.id);
        return (
          <Box key={row.record.id} flexDirection="column" marginTop={1}>
            <Text color={focused ? 'white' : 'cyan'} bold={focused}>
              {focused ? '▶ ' : '  '}
              {row.record.id} (CPL={row.record.criticalPathLength}, downstream=
              {row.record.dependents.length})
            </Text>
            {block?.lines.map((line, j) => (
              <Text key={j} color="gray">
                {'    '}
                {line}
              </Text>
            ))}
          </Box>
        );
      })}
      {truncated && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            … truncated to keep the view readable. Use `cli-deps inspect` for the full graph.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [↑↓] move focus [Esc] back to overview
        </Text>
      </Box>
    </Box>
  );
}
