/**
 * Blockers pane (top-left, default focus) — RFC-0023 §7.1 / §8 / AISDLC-178.3.
 *
 * Phase 3 implementation:
 *   - Consumes `useBlockers` hook (which runs the Phase 3 detector over
 *     Phase 2 data sources).
 *   - Renders each BlockerItem as a row: type icon, ID, one-line summary,
 *     age, urgency badge (AC#4).
 *   - Enter on a row opens a detail view (full-screen modal); Esc returns
 *     to overview mode (AC#5).
 *   - Detail view shows: full text, source context (PR URL / file path /
 *     evidence), action shortcuts (AC#6).
 *   - Empty-state copy when zero blockers (AC#7).
 *
 * The pane is self-contained: all data-fetching lives in the hook; the
 * component only handles render + keyboard routing.
 */

import { execFileSync } from 'node:child_process';
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { useBlockers } from '../blockers/use-blockers.js';
import type { BlockerItem, BlockerKind } from '../blockers/detector.js';

export const BLOCKERS_EMPTY_STATE = '✓ No decisions pending — pipeline self-driving';

// ── Kind icons ───────────────────────────────────────────────────────────────

const KIND_ICON: Record<BlockerKind, string> = {
  'urgent-decision': '🔴',
  'needs-clarification': '❓',
  'dor-comment': '💬',
  'triage-tbd': '🔍',
  'changes-requested': '🚫',
  'open-pr-question': '❔',
  'external-dep': '⏳',
};

const KIND_LABEL: Record<BlockerKind, string> = {
  'urgent-decision': 'URGENT',
  'needs-clarification': 'NEEDS-CLARIFY',
  'dor-comment': 'DOR-Q',
  'triage-tbd': 'TRIAGE-TBD',
  'changes-requested': 'CHANGES-REQD',
  'open-pr-question': 'PR-QUESTION',
  'external-dep': 'EXT-DEP',
};

const KIND_COLOR: Record<BlockerKind, string> = {
  'urgent-decision': 'red',
  'needs-clarification': 'yellow',
  'dor-comment': 'yellow',
  'triage-tbd': 'blue',
  'changes-requested': 'red',
  'open-pr-question': 'cyan',
  'external-dep': 'gray',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAge(updatedAt: string): string {
  if (!updatedAt) return '?';
  const ms = Date.now() - new Date(updatedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

// ── Detail view ──────────────────────────────────────────────────────────────

interface BlockerDetailProps {
  item: BlockerItem;
  onClose: () => void;
  onMarkNotADecision: (item: BlockerItem) => void;
}

function BlockerDetail({
  item,
  onClose,
  onMarkNotADecision,
}: BlockerDetailProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    if (input === 'o') {
      if (item.prUrl) {
        // Open in browser (best-effort; no crash on platforms without xdg-open).
        const opener =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'start'
              : 'xdg-open';
        try {
          execFileSync(opener, [item.prUrl], { stdio: 'ignore' });
        } catch {
          // Silently ignore if opener isn't available.
        }
      }
    }
    if (input === 'n') {
      onMarkNotADecision(item);
    }
  });

  const icon = KIND_ICON[item.kind];
  const kindColor = KIND_COLOR[item.kind];

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} width="100%">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={kindColor}>
          {icon} {item.ref} — {KIND_LABEL[item.kind]}
        </Text>
        {item.isUrgent && (
          <Text color="red" bold>
            {' '}
            [URGENT]
          </Text>
        )}
      </Box>

      {/* Summary */}
      <Box marginBottom={1}>
        <Text bold>{item.summary}</Text>
      </Box>

      {/* Detail text */}
      <Box marginBottom={1} flexDirection="column">
        <Text color="gray">─────────────────────────────────────────</Text>
        {item.detail.split('\n').map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>

      {/* Source context */}
      {item.prUrl && (
        <Box marginBottom={1}>
          <Text color="cyan">PR: {item.prUrl}</Text>
        </Box>
      )}
      {item.taskFilePath && (
        <Box marginBottom={1}>
          <Text color="gray">File: {item.taskFilePath}</Text>
        </Box>
      )}

      {/* Action shortcuts */}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">─────────────────────────────────────────</Text>
        <Text color="gray">Actions:</Text>
        {item.prUrl && <Text color="green"> [o] open PR in browser</Text>}
        {item.taskFilePath && <Text color="green"> [o] open task file in $EDITOR</Text>}
        <Text color="yellow"> [n] mark not-a-decision (add suppression marker)</Text>
        <Text color="gray"> [Esc] / [q] return to Blockers list</Text>
      </Box>
    </Box>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface BlockerRowProps {
  item: BlockerItem;
  isSelected: boolean;
}

function BlockerRow({ item, isSelected }: BlockerRowProps): React.ReactElement {
  const icon = KIND_ICON[item.kind];
  const color = KIND_COLOR[item.kind];
  const age = formatAge(item.updatedAt);
  const summary = truncate(item.summary, 48);

  return (
    <Box>
      {isSelected && (
        <Text color="white" bold>
          {'> '}
        </Text>
      )}
      {!isSelected && <Text>{'  '}</Text>}
      <Text color={color}>{icon} </Text>
      <Text bold={isSelected} color={isSelected ? 'white' : undefined}>
        {item.ref}
      </Text>
      <Text> </Text>
      <Text dimColor={!isSelected}>{summary}</Text>
      <Text color="gray"> [{age}]</Text>
      {item.isUrgent && (
        <Text color="red" bold>
          {' '}
          !
        </Text>
      )}
    </Box>
  );
}

// ── BlockersPane ──────────────────────────────────────────────────────────────

export interface BlockersPaneProps {
  /** Inject hook opts (tests). */
  hookOpts?: Parameters<typeof useBlockers>[0];
}

export function BlockersPane({ hookOpts }: BlockersPaneProps = {}): React.ReactElement {
  const { items, error } = useBlockers(hookOpts);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailItem, setDetailItem] = useState<BlockerItem | null>(null);

  // Clamp selection when list shrinks.
  const clampedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  useInput((input, key) => {
    if (detailItem) return; // Detail view has its own input handler.

    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    } else if (key.return && items.length > 0) {
      setDetailItem(items[clampedIndex] ?? null);
    }
  });

  // Detail view (full-screen modal).
  if (detailItem) {
    return (
      <BlockerDetail
        item={detailItem}
        onClose={() => setDetailItem(null)}
        onMarkNotADecision={() => {
          // Marking not-a-decision: close detail; the suppression marker
          // would be written by the operator's editor (Phase 5 action).
          // For now we just close the detail view.
          setDetailItem(null);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      {/* Header */}
      <Text bold color={items.length > 0 ? 'red' : 'green'}>
        {items.length > 0 ? '🛑' : '✓'} BLOCKERS ({items.length})
      </Text>
      <Text color="gray">─────────────────────────</Text>

      {/* Error banner */}
      {error && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            ⚠ Data source degraded: {error}
          </Text>
        </Box>
      )}

      {/* Empty state */}
      {items.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="green">{BLOCKERS_EMPTY_STATE}</Text>
        </Box>
      )}

      {/* Blocker rows */}
      {items.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {items.map((item, idx) => (
            <BlockerRow key={item.key} item={item} isSelected={idx === clampedIndex} />
          ))}
        </Box>
      )}

      {/* Navigation hint */}
      {items.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            [↑↓/jk] navigate [Enter] detail [Esc] back
          </Text>
        </Box>
      )}
    </Box>
  );
}
