/**
 * Blockers pane (top-left, default focus) — RFC-0023 §7.1.
 *
 * Phase 1: placeholder. Renders the OQ-9 affirming empty-state copy
 * `✓ No decisions pending — pipeline self-driving` per RFC-0023 §15 OQ-9.
 *
 * Phase 3 (AISDLC-178.3) wires the decision-pending detector that scans
 * `Needs Clarification` tasks, unaddressed CHANGES_REQUESTED reviews,
 * external-deps gates, soak-window timers, and operator overrides.
 */

import React from 'react';
import { Box, Text } from 'ink';

export const BLOCKERS_EMPTY_STATE = '✓ No decisions pending — pipeline self-driving';

export function BlockersPane(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="red">
        🛑 BLOCKERS (0)
      </Text>
      <Text color="gray">─────────────────────────</Text>
      <Box marginTop={1}>
        <Text color="green">{BLOCKERS_EMPTY_STATE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          (Phase 3: Needs Clarification, unaddressed reviews, external deps, soak timers)
        </Text>
      </Box>
    </Box>
  );
}
