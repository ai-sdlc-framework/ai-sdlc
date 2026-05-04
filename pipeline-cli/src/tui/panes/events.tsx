/**
 * Events pane (bottom, full-width) — RFC-0023 §7.5.
 *
 * Phase 1: placeholder. Phase 2 (AISDLC-178.2) wires the events.jsonl
 * tail reader.
 *
 * Will live-tail filtered operator-relevant event types (DispatchStarted,
 * PrMerged, ReviewerApproved, ReviewerChangesRequested, OrchestratorRollback,
 * OrchestratorWorkQuarantined, OrchestratorOrphanParent, etc.). Scrollable
 * with j/k. Search via /. New events highlight briefly.
 */

import React from 'react';
import { Box, Text } from 'ink';

export function EventsPane(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="blue">
        📡 EVENTS (live tail)
      </Text>
      <Text color="gray">
        ─────────────────────────────────────────────────────────────────────
      </Text>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          (Phase 2: events.jsonl tail — filtered to operator-relevant types)
        </Text>
      </Box>
    </Box>
  );
}
