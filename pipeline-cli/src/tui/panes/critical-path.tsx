/**
 * Critical Path pane (bottom-left) — RFC-0023 §7.3.
 *
 * Phase 1: placeholder. Phase 4 (AISDLC-178.4) wires the RFC-0014 dep
 * snapshot reader.
 *
 * Will render the dispatch frontier sorted by effectivePriority +
 * criticalPathLength, showing the next ~5–10 tasks the orchestrator would
 * pick up. Per-row: ID, title, effPri, CPL, blast-radius (RFC-0014 Phase 3).
 */

import React from 'react';
import { Box, Text } from 'ink';

export function CriticalPathPane(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="yellow">
        🛤️ CRITICAL PATH (frontier)
      </Text>
      <Text color="gray">─────────────────────────</Text>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          (Phase 4: RFC-0014 dep frontier — effPri, CPL, blast-radius)
        </Text>
      </Box>
    </Box>
  );
}
