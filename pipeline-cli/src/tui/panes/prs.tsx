/**
 * PRs pane (top-right) — RFC-0023 §7.2 / AISDLC-178.4.
 *
 * Phase 4 (AISDLC-178.4): wires the gh PR cache from Phase 2 via usePrs().
 * Renders every open PR with: number, branch (truncated), title (truncated),
 * CI glyph (✓/⏳/✗), review state, merge state, and a "next step" annotation.
 * Color-coded by urgency. Sorted by operator-attention required descending.
 */

import React from 'react';
import { PrsPaneContent } from '../prs/pane.js';
import { usePrs } from '../prs/use-prs.js';

export function PrsPane(): React.ReactElement {
  const { rows, error } = usePrs();
  return <PrsPaneContent rows={rows} error={error} />;
}
