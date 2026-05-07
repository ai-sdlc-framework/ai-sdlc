/**
 * PRs pane (top-right) — RFC-0023 §7.2 / AISDLC-178.4 + AISDLC-178.4.1.
 *
 * Phase 4 (AISDLC-178.4): wires the gh PR cache from Phase 2 via usePrs().
 * AISDLC-178.4.1: enriches rows with PR critical-path info derived from the
 * latest dep snapshot (when available) + optional depends-on labels/body
 * markers + (future) git ancestry. Rows arrive sorted by critical-path-length
 * DESC by default; the `s` keystroke cycles through recency / ci-status.
 *
 * The dep snapshot is fetched on demand by the Critical Path pane already;
 * we read the latest one here so PR chain derivation stays in sync. If no
 * snapshot is on disk yet, chain info degrades to singletons (cpl=0) and
 * the sort falls through to age ASC — the pane keeps working without
 * RFC-0014 composition turned on.
 */

import React from 'react';
import { PrsPaneContent } from '../prs/pane.js';
import { usePrs } from '../prs/use-prs.js';
import { useDepSnapshot } from '../sources/dep-snapshot-reader.js';
import { useEffect, useRef } from 'react';

export function PrsPane(): React.ReactElement {
  // Fetch the latest dep snapshot once on mount so PR chain derivation
  // can read task→PR dependency edges. Same pattern as `useCriticalPath`.
  const snapshot = useDepSnapshot();
  const refreshRef = useRef(snapshot.refresh);
  refreshRef.current = snapshot.refresh;
  useEffect(() => {
    refreshRef.current();
  }, []);

  const { rows, graph, error, prs } = usePrs({
    snapshotRecords: snapshot.data?.records ?? [],
  });
  return <PrsPaneContent rows={rows} prs={prs} graph={graph} error={error} />;
}
