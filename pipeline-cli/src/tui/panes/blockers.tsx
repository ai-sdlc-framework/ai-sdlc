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
import { launchKanban, type KanbanLaunchResult } from '../kanban.js';
import { loadTuiConfig } from '../tui-config.js';
import { useIsFullScreen, useSearch } from '../modes/router.js';

export const BLOCKERS_EMPTY_STATE = '✓ No decisions pending — pipeline self-driving';

/** Resolve the empty-state copy, honoring `.ai-sdlc/tui-config.yaml` (OQ-9). */
function resolveEmptyState(workDir?: string): string {
  const config = loadTuiConfig({ workDir });
  return config.blockersEmptyState ?? BLOCKERS_EMPTY_STATE;
}

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

/**
 * Extract a task ID (e.g. `AISDLC-178.5`) from a BlockerItem. Tasks
 * surface as `ref: AISDLC-NNN`; PR blockers (ref: `#42`) return null and
 * the kanban link-out is skipped.
 */
export function extractTaskId(item: BlockerItem): string | null {
  if (!item.ref) return null;
  const match = /^([A-Z][A-Z0-9]*-[\d.]+)$/.exec(item.ref);
  return match ? match[1] : null;
}

/**
 * Filter blockers by search query (substring match against ref + summary).
 * No-op when not in full-screen mode or when query is null/empty (Overview
 * Mode keeps every blocker visible per AC#9).
 */
export function filterBlockers(
  items: BlockerItem[],
  isFullScreen: boolean,
  query: string | null,
): BlockerItem[] {
  if (!isFullScreen || !query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (b) =>
      b.ref.toLowerCase().includes(q) ||
      b.summary.toLowerCase().includes(q) ||
      b.detail.toLowerCase().includes(q),
  );
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
        // Open PR in browser (best-effort; no crash on platforms without xdg-open).
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
      } else if (item.taskFilePath) {
        // Open task file in $EDITOR per RFC §8 ("one-keystroke action: open
        // task in editor"). The hint text on the row already says "[o] open
        // task file in $EDITOR" — without this branch the keystroke was a
        // no-op (#383 review fix). Fall back to nothing if EDITOR is unset
        // (don't pick a guess like vim — the operator's choice).
        const editor = process.env.EDITOR ?? process.env.VISUAL;
        if (editor) {
          try {
            // Use shell so $EDITOR can be `code -w` etc; the path is
            // controlled (originates from local backlog file walker).
            execFileSync('sh', ['-c', `${editor} "$1"`, '-', item.taskFilePath], {
              stdio: 'inherit',
            });
          } catch {
            // Silently ignore if editor exits non-zero or isn't on PATH.
          }
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
  /**
   * Inject the kanban launcher (tests). Defaults to the production
   * `launchKanban` (open / xdg-open / pbcopy fallback chain).
   */
  kanbanLauncher?: typeof launchKanban;
  /**
   * Force the pane to behave as if it were full-screen for the `b`
   * kanban-link keystroke (tests). When omitted, falls back to the
   * router's FullScreenContext.
   */
  forceFullScreen?: boolean;
  /** Override the resolved empty-state copy (tests). */
  emptyStateOverride?: string;
  /** Project root for OQ-9 tui-config.yaml lookup. Defaults `process.cwd()`. */
  workDir?: string;
}

export function BlockersPane({
  hookOpts,
  kanbanLauncher = launchKanban,
  forceFullScreen,
  emptyStateOverride,
  workDir,
}: BlockersPaneProps = {}): React.ReactElement {
  const { items: rawItems, error } = useBlockers(hookOpts);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailItem, setDetailItem] = useState<BlockerItem | null>(null);
  const [kanbanStatus, setKanbanStatus] = useState<KanbanLaunchResult | null>(null);

  const { query: searchQuery } = useSearch();
  const ctxFullScreen = useIsFullScreen();
  const isFullScreen = forceFullScreen ?? ctxFullScreen;

  // AC#9: search (/) filters the active pane by substring match. Only
  // applied while the pane is full-screen — Overview Mode keeps showing
  // every blocker so the operator's at-a-glance read isn't pruned.
  const items = filterBlockers(rawItems, isFullScreen, searchQuery);

  // Clamp selection when list shrinks.
  const clampedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  const emptyState = emptyStateOverride ?? resolveEmptyState(workDir);

  useInput((input, key) => {
    if (detailItem) return; // Detail view has its own input handler.

    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    } else if (key.return && items.length > 0) {
      setDetailItem(items[clampedIndex] ?? null);
    } else if (input === 'b' && isFullScreen && items.length > 0) {
      // RFC §11 / OQ-5: from any task row, `b` opens the backlog.md
      // kanban filtered to that task. Only fires in full-screen mode so
      // the same `b` keystroke in Overview Mode remains a mode-switch.
      const focused = items[clampedIndex];
      const taskId = extractTaskId(focused);
      if (taskId) {
        const config = loadTuiConfig({ workDir });
        const url = `${(config.kanbanBaseUrl ?? 'http://localhost:6420').replace(/\/+$/, '')}/?task=${encodeURIComponent(taskId)}`;
        const result = kanbanLauncher({ url });
        setKanbanStatus(result);
      }
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

      {/* Error banner */}
      {error && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            ⚠ Data source degraded: {error}
          </Text>
        </Box>
      )}

      {/* Empty state — OQ-9 affirming copy, overridable via .ai-sdlc/tui-config.yaml */}
      {items.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="green">{emptyState}</Text>
        </Box>
      )}

      {/* Kanban link-out status (AC#8) */}
      {kanbanStatus && (
        <Box marginTop={1}>
          {kanbanStatus.outcome === 'browser' && (
            <Text color="green">↗ opened {kanbanStatus.url} in browser</Text>
          )}
          {kanbanStatus.outcome === 'clipboard' && (
            <Text color="yellow">
              📋 copied {kanbanStatus.url} to clipboard ({kanbanStatus.tool})
            </Text>
          )}
          {kanbanStatus.outcome === 'none' && (
            <Text color="red">
              ✗ couldn't launch browser/clipboard. Open this URL: {kanbanStatus.url}
            </Text>
          )}
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
