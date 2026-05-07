/**
 * Critical Path pane logic — RFC-0023 §7.3 / AISDLC-178.4.
 *
 * Consumes `useDepSnapshot` from Phase 2 and derives the sorted frontier
 * the operator TUI displays.
 *
 * Sort order (mirrors `cli-deps frontier` per AC #7):
 *   effectivePriority DESC → criticalPathLength DESC → recency DESC → id ASC
 *
 * Also provides `buildAsciiDepTree()` for the detail-view ASCII rendering
 * (parents above, children below the focused task).
 */

import type { SnapshotRecord } from '../../deps/snapshot.js';
import type { UseDepSnapshotOpts, UseDepSnapshotState } from '../sources/dep-snapshot-reader.js';
import { useDepSnapshot } from '../sources/dep-snapshot-reader.js';
import { useEffect, useRef } from 'react';

// ── Priority mapping ──────────────────────────────────────────────────────────

/**
 * Snapshot records don't carry explicit effectivePriority yet (the dep
 * snapshot writer stores it for RFC-0014 Phase 2 callers). We derive it
 * from `criticalPathLength` as a proxy: a longer chain → higher effective
 * urgency as a first approximation. This is AC #7's "effectivePriority
 * DESC" ordering with the available data.
 *
 * When the snapshot record gains an explicit `effectivePriority` field in a
 * future phase, the comparator can be updated to use it directly.
 */
function effectivePriorityProxy(record: SnapshotRecord): number {
  // criticalPathLength as a stand-in — higher CPL = more dependents = more urgent
  return record.criticalPathLength;
}

// ── Sort ──────────────────────────────────────────────────────────────────────

/**
 * Sort SnapshotRecords per RFC §7.3 / AC #7:
 *   effectivePriority DESC → criticalPathLength DESC → recency DESC → id ASC
 */
export function sortCriticalPath(records: SnapshotRecord[]): SnapshotRecord[] {
  return [...records].sort((a, b) => {
    const effA = effectivePriorityProxy(a);
    const effB = effectivePriorityProxy(b);
    if (effB !== effA) return effB - effA; // effectivePriority DESC

    const cplDiff = b.criticalPathLength - a.criticalPathLength;
    if (cplDiff !== 0) return cplDiff; // criticalPathLength DESC

    // Recency DESC — ISO-8601 string sort (lexicographic = chronological)
    const dateA = a.lastModified ?? '';
    const dateB = b.lastModified ?? '';
    if (dateB > dateA) return 1;
    if (dateA > dateB) return -1;

    // ID ASC as final tiebreak
    return a.id.localeCompare(b.id);
  });
}

// ── ASCII dep tree ────────────────────────────────────────────────────────────

/**
 * Render an ASCII dependency tree for the detail view.
 *
 * Layout:
 *   Parents (tasks this task depends on) above — rendered as ancestors.
 *   The focused task in the middle, marked with *.
 *   Children (tasks that depend on this task) below.
 *
 * Only one level of parents and children is rendered (direct edges) to
 * keep the ASCII tree readable in the pane.
 */
export function buildAsciiDepTree(focused: SnapshotRecord, all: SnapshotRecord[]): string[] {
  const byId = new Map<string, SnapshotRecord>(all.map((r) => [r.id.toLowerCase(), r]));

  const lines: string[] = [];

  // Parents (dependencies)
  if (focused.dependencies.length > 0) {
    lines.push('Dependencies (parents):');
    for (const depId of focused.dependencies) {
      const parent = byId.get(depId.toLowerCase());
      const label = parent ? `${depId}` : `${depId} (not in snapshot)`;
      lines.push(`  ┌─ ${label}`);
    }
    lines.push('  │');
  }

  // Focused task
  lines.push(
    `  * ${focused.id}  [effPri≈${effectivePriorityProxy(focused)} CPL=${focused.criticalPathLength} downstream=${focused.dependents.length}]`,
  );

  // Children (dependents)
  if (focused.dependents.length > 0) {
    lines.push('  │');
    lines.push('Dependents (children):');
    for (const childId of focused.dependents) {
      const child = byId.get(childId.toLowerCase());
      const label = child ? `${childId}` : `${childId} (not in snapshot)`;
      lines.push(`  └─ ${label}`);
    }
  }

  return lines;
}

// ── Derived row ───────────────────────────────────────────────────────────────

/** Derived row ready for the Critical Path pane to render. */
export interface CriticalPathRow {
  record: SnapshotRecord;
  /** effectivePriority proxy value. */
  effPri: number;
  /** Blast-radius = downstream count (dependents.length). */
  blastRadius: number;
}

export function buildCriticalPathRows(records: SnapshotRecord[]): CriticalPathRow[] {
  return sortCriticalPath(records).map((record) => ({
    record,
    effPri: effectivePriorityProxy(record),
    blastRadius: record.dependents.length,
  }));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseCriticalPathState {
  rows: CriticalPathRow[];
  allRecords: SnapshotRecord[];
  error: import('../sources/types.js').SourceErrorKind | null;
  lastFetched: Date | null;
  refresh: () => void;
}

/**
 * React hook — wraps `useDepSnapshot` and exposes sorted `CriticalPathRow[]`
 * ready for the Critical Path pane to render.
 *
 * Triggers an initial refresh on mount so the pane populates without
 * requiring a manual `r` keystroke on first load.
 */
export function useCriticalPath(opts: UseDepSnapshotOpts = {}): UseCriticalPathState {
  const state: UseDepSnapshotState = useDepSnapshot(opts);

  // Kick off an initial read on mount — the dep-snapshot hook is on-demand
  // by design, but the Critical Path pane should show data immediately.
  // Capture refresh in a ref so the effect only fires on mount.
  const refreshRef = useRef(state.refresh);
  refreshRef.current = state.refresh;

  useEffect(() => {
    refreshRef.current();
  }, []);

  const records = state.data?.records ?? [];
  const rows = buildCriticalPathRows(records);

  return {
    rows,
    allRecords: records,
    error: state.error,
    lastFetched: state.lastFetched,
    refresh: state.refresh,
  };
}
