/**
 * Analytics pane (bottom-right) — RFC-0023 §7.4.
 *
 * Phase 1: placeholder. Phase 6 (AISDLC-178.6) wires operator-throughput
 * metrics from `_operator/decisions.jsonl` + `events.jsonl`.
 *
 * Per OQ-3 resolution (RFC-0023 §15): operator-throughput metrics render
 * FIRST, with pipeline metrics below a visual divider.
 */

import React from 'react';
import { Box, Text } from 'ink';

export function AnalyticsPane(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="magenta">
        📊 LAST 24H
      </Text>
      <Text color="gray">─────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          (Phase 6: operator-throughput primary, pipeline metrics below)
        </Text>
      </Box>
    </Box>
  );
}
