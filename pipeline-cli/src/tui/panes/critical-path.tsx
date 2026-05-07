/**
 * Critical Path pane (bottom-left) — RFC-0023 §7.3 / AISDLC-178.4.
 *
 * Phase 4 (AISDLC-178.4): wires the RFC-0014 dep snapshot reader from Phase 2
 * via useCriticalPath(). Renders the dispatch frontier sorted by
 * effectivePriority + criticalPathLength, showing the next ~5–10 tasks the
 * orchestrator would dispatch.
 *
 * Per row: task ID, effPri, CPL, blast-radius (downstream count).
 * Enter opens detail with ASCII dep tree (parents above, children below).
 */

import React from 'react';
import { CriticalPathPaneContent } from '../critical-path/pane.js';
import { useCriticalPath } from '../critical-path/use-critical-path.js';

export function CriticalPathPane(): React.ReactElement {
  const { rows, allRecords, error } = useCriticalPath();
  return <CriticalPathPaneContent rows={rows} allRecords={allRecords} error={error} />;
}
