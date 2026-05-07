/**
 * Analytics pane (bottom-right + full-screen) — RFC-0023 §7.4 / §10 /
 * AC#5–#7 / AISDLC-178.6.
 *
 * Per OQ-3 resolution: operator-throughput renders FIRST (top), pipeline
 * metrics SECOND (below a visual divider). Both sections render in the
 * same component because the operator's mental model is "the operator
 * dashboard" — not two separate panes.
 *
 * Phase 6 surface:
 *   - useAnalytics() snapshots the underlying sources every 5s.
 *   - Operator section: decisions resolved (24h), avg time-to-decision,
 *     % WIP blocked on operator, stale captures.
 *   - Pipeline section: dispatched / merged / failed / quarantined (24h)
 *     plus reliability trend (RFC-0025; "no data" when not available).
 */

import React from 'react';
import { Box, Text } from 'ink';

import { useEvents } from '../sources/events-tail.js';
import { useBacklogTasks } from '../sources/backlog-walker.js';
import { useAnalytics, type UseAnalyticsOpts } from '../analytics/use-analytics.js';
import {
  formatDurationCompact,
  formatReliabilityTrend,
  type OperatorMetrics,
  type PipelineMetrics,
} from '../analytics/metrics.js';

export const ANALYTICS_OPERATOR_HEADING = '👥 OPERATOR THROUGHPUT';
export const ANALYTICS_PIPELINE_HEADING = '⚙ PIPELINE THROUGHPUT (LAST 24H)';
/** Used at the top + as the visual divider between the two sections. */
export const ANALYTICS_DIVIDER = '─────────────────────────────────────';
export const ANALYTICS_SECTION_DIVIDER = '═════════════════════════════════════';

export interface AnalyticsPaneProps {
  /** Inject useAnalytics opts (tests). */
  hookOpts?: UseAnalyticsOpts;
}

function OperatorSection({ metrics }: { metrics: OperatorMetrics }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        {ANALYTICS_OPERATOR_HEADING}
      </Text>
      <Text color="gray">{ANALYTICS_DIVIDER}</Text>
      <Text>
        Decisions resolved (24h):{' '}
        <Text bold color="green">
          {metrics.decisionsResolved24h}
        </Text>
      </Text>
      <Text>
        Avg time-to-decision: <Text bold>{formatDurationCompact(metrics.avgTimeToDecisionMs)}</Text>
      </Text>
      <Text>
        % WIP blocked on operator:{' '}
        <Text bold color={metrics.pctWipBlockedOnOperator > 50 ? 'yellow' : 'cyan'}>
          {metrics.pctWipBlockedOnOperator}%
        </Text>
      </Text>
      <Text>
        Stale captures:{' '}
        <Text bold color={metrics.staleCapturesCount > 0 ? 'red' : 'gray'}>
          {metrics.staleCapturesCount}
        </Text>
      </Text>
    </Box>
  );
}

function PipelineSection({ metrics }: { metrics: PipelineMetrics }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {ANALYTICS_PIPELINE_HEADING}
      </Text>
      <Text color="gray">{ANALYTICS_DIVIDER}</Text>
      <Text>
        Dispatched: <Text bold>{metrics.dispatched24h}</Text>
        {'  '}
        Merged:{' '}
        <Text bold color="green">
          {metrics.merged24h}
        </Text>
      </Text>
      <Text>
        Failed:{' '}
        <Text bold color="red">
          {metrics.failed24h}
        </Text>
        {'  '}
        Quarantined:{' '}
        <Text bold color="yellow">
          {metrics.quarantined24h}
        </Text>
      </Text>
      <Text>
        Reliability trend: <Text bold>{formatReliabilityTrend(metrics.reliability)}</Text>
      </Text>
    </Box>
  );
}

export function AnalyticsPane({ hookOpts }: AnalyticsPaneProps = {}): React.ReactElement {
  // Consume the existing data sources so the pane stays live in
  // production. Tests pass `hookOpts.events`/`hookOpts.tasks` directly to
  // bypass the I/O layer.
  const eventsState = useEvents();
  const tasksState = useBacklogTasks();

  const composedOpts: UseAnalyticsOpts = {
    ...hookOpts,
    events: hookOpts?.events ?? eventsState.data,
    tasks: hookOpts?.tasks ?? tasksState.data,
  };
  const snap = useAnalytics(composedOpts);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <OperatorSection metrics={snap.operator} />

      {/* AC#7 — clear visual divider between operator + pipeline sections. */}
      <Box marginY={1}>
        <Text color="gray">{ANALYTICS_SECTION_DIVIDER}</Text>
      </Box>

      <PipelineSection metrics={snap.pipeline} />
    </Box>
  );
}
