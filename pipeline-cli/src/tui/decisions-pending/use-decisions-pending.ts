/**
 * useDecisionsPending React hook — RFC-0035 Phase 8 / AISDLC-292 AC#1.
 *
 * Reads the RFC-0035 Decision event log (`.ai-sdlc/_decisions/events.jsonl`),
 * projects the current state of all Decisions, and returns only the
 * `open` (pending) ones sorted by priority signal descending.
 *
 * The hook polls on a configurable interval (default 15s — Decisions change
 * infrequently compared to blockers). Operators trigger an immediate refresh
 * via `r` keystroke (RefreshContext nonce).
 *
 * @module tui/decisions-pending/use-decisions-pending
 */

import { useEffect, useRef, useState } from 'react';

import { listDecisions } from '../../decisions/projection.js';
import type { ReadEventsOpts } from '../../decisions/event-log.js';
import type { Decision } from '../../decisions/decision-record.js';
import type { SourceErrorKind } from '../sources/types.js';
import { useRefreshNonce } from '../modes/router.js';

// ── Poll interval ─────────────────────────────────────────────────────────────

/** Default poll interval for the decision event log. */
export const DECISIONS_POLL_INTERVAL_MS = 15_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface UseDecisionsPendingOpts {
  /** Work directory (used to locate `.ai-sdlc/_decisions/events.jsonl`). */
  workDir?: string;
  /** Poll cadence override (tests). */
  intervalMs?: number;
  /**
   * Override the decision lister (tests).  Defaults to `listDecisions` from
   * `decisions/event-log`.
   */
  lister?: (opts: ReadEventsOpts) => { decisions: Decision[]; skipped: number };
}

export interface UseDecisionsPendingState {
  /** Open (pending) decisions sorted by priority DESC, then creation ASC. */
  decisions: Decision[];
  /**
   * Source error (event log unreadable), or null.  The pane renders a
   * degradation banner per RFC-0023 §12 when non-null.
   */
  error: SourceErrorKind | null;
  /** Wall-clock of most-recent poll. */
  lastFetched: Date | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the numeric priority from a Decision's status (from the
 * `recommendation-issued` event's `prioritySignal` field, projected
 * onto `status.priority`).  Falls back to 0.5 when absent.
 */
function decisionPriority(d: Decision): number {
  return typeof d.status.priority === 'number' ? d.status.priority : 0.5;
}

/**
 * Filter and sort decisions: keep only `open` lifecycle, sort by
 * priority signal DESC; ties broken by creation date ASC (oldest first).
 */
export function filterAndSort(all: Decision[]): Decision[] {
  return all
    .filter((d) => d.status.lifecycle === 'open')
    .sort((a, b) => {
      const pa = decisionPriority(a);
      const pb = decisionPriority(b);
      if (pb !== pa) return pb - pa; // priority DESC
      return a.metadata.created.localeCompare(b.metadata.created); // creation ASC
    });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * React hook — polls the Decision event log, projects pending Decisions,
 * and returns them sorted for display in the DecisionsPendingPane.
 */
export function useDecisionsPending(opts: UseDecisionsPendingOpts = {}): UseDecisionsPendingState {
  const { workDir, intervalMs = DECISIONS_POLL_INTERVAL_MS } = opts;
  const lister = opts.lister ?? listDecisions;

  const { nonce: refreshNonce } = useRefreshNonce();

  const listerRef = useRef(lister);
  listerRef.current = lister;

  // Synchronous lazy initializer — populates the first frame with decisions
  // without waiting for useEffect to fire (important for tests and for
  // eliminating the empty-state flash on mount).  useEffect still fires an
  // immediate poll so that dependency changes (workDir, nonce) trigger a
  // refresh even though the initial frame is already populated.
  const [state, setState] = useState<UseDecisionsPendingState>(() => {
    try {
      const { decisions: all } = lister({ workDir });
      return {
        decisions: filterAndSort(all),
        error: null,
        lastFetched: new Date(),
      };
    } catch {
      return {
        decisions: [],
        error: 'source-unavailable' as SourceErrorKind,
        lastFetched: null,
      };
    }
  });

  useEffect(() => {
    let cancelled = false;

    function poll(): void {
      try {
        const { decisions: all } = listerRef.current({ workDir });
        if (!cancelled) {
          setState({
            decisions: filterAndSort(all),
            error: null,
            lastFetched: new Date(),
          });
        }
      } catch {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: 'source-unavailable' as SourceErrorKind,
          }));
        }
      }
    }

    poll();
    const handle = setInterval(poll, intervalMs);
    return (): void => {
      cancelled = true;
      clearInterval(handle);
    };
    // Re-run when workDir, intervalMs, or the refresh nonce changes.
    // listerRef is intentionally excluded — it's updated via ref to avoid
    // stale-closure churn on re-renders where only the lister fn ref changed.
  }, [workDir, intervalMs, refreshNonce]);

  return state;
}
