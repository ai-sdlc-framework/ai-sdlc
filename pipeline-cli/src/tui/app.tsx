/**
 * Top-level App component for the operator TUI (RFC-0023 Phase 1 / AISDLC-178.1).
 *
 * Renders Overview Mode — five panes per RFC-0023 §7 — and wraps it in the
 * `ModeRouter` (Phase 5 / AISDLC-178.5) which handles mode-switch keystrokes
 * (b/p/d/c/a/?), `/` search, `r` refresh, and Esc-to-overview.
 */

import React from 'react';
import { Box, useApp, useInput } from 'ink';
import { BlockersPane } from './panes/blockers.js';
import { PrsPane } from './panes/prs.js';
import { CriticalPathPane } from './panes/critical-path.js';
import { AnalyticsPane } from './panes/analytics.js';
import { EventsPane } from './panes/events.js';
import { Footer } from './footer.js';
import { ModeRouter } from './modes/router.js';

/**
 * Pure keystroke dispatcher — extracted so tests can exercise the routing
 * table without needing to drive Ink's raw-mode input pipeline (which the
 * test stdin shim in `ink-testing-library` does not actually wire through
 * to `useInput` callbacks). Returns true if the keystroke was consumed.
 *
 * The router (`modes/router.tsx`) handles every other key. `q` ALSO routes
 * through here for the Phase 1 baseline behaviour: tests written against
 * Phase 1 still rely on `handleAppKey('q', ...)` invoking exit. The router
 * also handles `q` while in Overview Mode to keep the old behaviour intact.
 */
export function handleAppKey(input: string, actions: { exit: () => void }): boolean {
  if (input === 'q') {
    actions.exit();
    return true;
  }
  return false;
}

function OverviewLayout(): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Top half: Blockers + PRs side-by-side */}
      <Box flexDirection="row" flexGrow={1}>
        <Box width="50%">
          <BlockersPane />
        </Box>
        <Box width="50%">
          <PrsPane />
        </Box>
      </Box>

      {/* Middle half: CriticalPath + Analytics side-by-side */}
      <Box flexDirection="row" flexGrow={1}>
        <Box width="50%">
          <CriticalPathPane />
        </Box>
        <Box width="50%">
          <AnalyticsPane />
        </Box>
      </Box>

      {/* Bottom strip: full-width Events tail */}
      <Box flexDirection="row">
        <EventsPane />
      </Box>

      {/* Footer: keystroke legend */}
      <Footer />
    </Box>
  );
}

export function App(): React.ReactElement {
  const { exit } = useApp();

  useInput((input) => {
    handleAppKey(input, { exit });
  });

  return <ModeRouter overviewSlot={<OverviewLayout />} />;
}
