/**
 * PRs pane (top-right) — RFC-0023 §7.2.
 *
 * Phase 1: placeholder. Phase 4 (AISDLC-178.4) wires the gh PR cache.
 *
 * Will display every open PR with: number, branch, title (truncated),
 * CI status, review state, merge state, and a "next step" annotation.
 * Sorted by operator-attention required descending.
 */

import React from 'react';
import { Box, Text } from 'ink';

export function PrsPane(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        📦 PRs IN FLIGHT (—)
      </Text>
      <Text color="gray">─────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          (Phase 4: open PRs with CI/review/merge state, sorted by operator-attention)
        </Text>
      </Box>
    </Box>
  );
}
