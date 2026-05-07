/**
 * Tests for the composite useAnalytics hook (AISDLC-178.6).
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import { useAnalytics } from './use-analytics.js';
import { NEEDS_CLARIFICATION_STATUS, type DecisionRecord } from './decisions-writer.js';
import type { ReliabilityTrend } from './quality-reader.js';
import type { BacklogTask } from '../sources/backlog-walker.js';

afterEach(() => cleanup());

const NOW = new Date('2026-05-15T12:00:00.000Z');

const D: DecisionRecord = {
  ts: '2026-05-15T11:00:00.000Z',
  taskId: 'AISDLC-100',
  fromStatus: NEEDS_CLARIFICATION_STATUS,
  toStatus: 'In Progress',
  clarificationPostedAt: '2026-05-15T08:00:00.000Z',
  resolvedAt: '2026-05-15T11:00:00.000Z',
  durationMs: 3 * 60 * 60 * 1000,
};

const NO_RELIABILITY: ReliabilityTrend = {
  available: false,
  thisWeek: 0,
  lastWeek: 0,
  delta: 0,
};

function Probe({
  capture,
  records,
  tasks,
}: {
  capture: (snap: ReturnType<typeof useAnalytics>) => void;
  records: DecisionRecord[];
  tasks: BacklogTask[];
}): React.ReactElement {
  const snap = useAnalytics({
    decisionsReader: () => ({ records, error: null }),
    reliabilityReader: () => NO_RELIABILITY,
    tasks,
    events: [],
    now: () => NOW,
  });
  capture(snap);
  return <Text>tick={snap.operator.decisionsResolved24h}</Text>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('useAnalytics', () => {
  it('emits an empty snapshot when all sources are empty', async () => {
    let captured: ReturnType<typeof useAnalytics> | null = null;
    render(
      <Probe
        records={[]}
        tasks={[]}
        capture={(s) => {
          captured = s;
        }}
      />,
    );
    await flush();
    expect(captured!.empty).toBe(true);
    expect(captured!.operator.decisionsResolved24h).toBe(0);
    expect(captured!.pipeline.reliability.available).toBe(false);
  });

  it('emits a populated snapshot when records are present', async () => {
    let captured: ReturnType<typeof useAnalytics> | null = null;
    render(
      <Probe
        records={[D]}
        tasks={[]}
        capture={(s) => {
          captured = s;
        }}
      />,
    );
    await flush();
    expect(captured!.empty).toBe(false);
    expect(captured!.operator.decisionsResolved24h).toBe(1);
    expect(captured!.operator.avgTimeToDecisionMs).toBe(3 * 60 * 60 * 1000);
  });
});
