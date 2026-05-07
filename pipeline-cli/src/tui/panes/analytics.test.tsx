/**
 * Analytics pane component tests (AISDLC-178.6 AC#5–#7, #8, #11).
 *
 * Mirrors the `blockers.test.tsx` pattern — ink-testing-library + injected
 * hookOpts so the I/O layer is bypassed and the assertions are
 * deterministic.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import {
  AnalyticsPane,
  ANALYTICS_OPERATOR_HEADING,
  ANALYTICS_PIPELINE_HEADING,
  ANALYTICS_SECTION_DIVIDER,
} from './analytics.js';
import { NEEDS_CLARIFICATION_STATUS, type DecisionRecord } from '../analytics/decisions-writer.js';
import type { ReliabilityTrend } from '../analytics/quality-reader.js';
import type { OrchestratorEvent } from '../../orchestrator/events.js';
import type { BacklogTask } from '../sources/backlog-walker.js';

afterEach(() => cleanup());

const NOW = new Date('2026-05-15T12:00:00.000Z');

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: '2026-05-15T11:00:00.000Z',
    taskId: 'AISDLC-100',
    fromStatus: NEEDS_CLARIFICATION_STATUS,
    toStatus: 'In Progress',
    clarificationPostedAt: '2026-05-15T08:00:00.000Z',
    resolvedAt: '2026-05-15T11:00:00.000Z',
    durationMs: 3 * 60 * 60 * 1000,
    ...overrides,
  };
}

function task(overrides: Partial<BacklogTask> = {}): BacklogTask {
  return {
    id: 'AISDLC-100',
    title: 'sample',
    status: 'In Progress',
    priority: '',
    labels: [],
    dependencies: [],
    fileLocation: 'open',
    filePath: '/x.md',
    lastModified: NOW.toISOString(),
    extras: {},
    ...overrides,
  };
}

function event(type: OrchestratorEvent['type'], offsetMs = 0): OrchestratorEvent {
  return { ts: new Date(NOW.getTime() - offsetMs).toISOString(), type };
}

const NO_RELIABILITY: ReliabilityTrend = {
  available: false,
  thisWeek: 0,
  lastWeek: 0,
  delta: 0,
};

const RELIABILITY_AVAILABLE: ReliabilityTrend = {
  available: true,
  thisWeek: 2,
  lastWeek: 5,
  delta: -3,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('AnalyticsPane render', () => {
  it('renders OPERATOR THROUGHPUT first and PIPELINE THROUGHPUT second (AC#5, #6, OQ-3)', async () => {
    const { lastFrame } = render(
      <AnalyticsPane
        hookOpts={{
          decisionsReader: () => ({ records: [decision()], error: null }),
          reliabilityReader: () => NO_RELIABILITY,
          tasks: [task({ status: NEEDS_CLARIFICATION_STATUS })],
          events: [event('OrchestratorDispatched', 60_000)],
          now: () => NOW,
        }}
      />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(ANALYTICS_OPERATOR_HEADING);
    expect(frame).toContain(ANALYTICS_PIPELINE_HEADING);
    // Operator heading must come first.
    const opIdx = frame.indexOf(ANALYTICS_OPERATOR_HEADING);
    const pipIdx = frame.indexOf(ANALYTICS_PIPELINE_HEADING);
    expect(opIdx).toBeGreaterThanOrEqual(0);
    expect(pipIdx).toBeGreaterThan(opIdx);
  });

  it('renders the visual divider between the two sections (AC#7)', async () => {
    const { lastFrame } = render(
      <AnalyticsPane
        hookOpts={{
          decisionsReader: () => ({ records: [], error: null }),
          reliabilityReader: () => NO_RELIABILITY,
          tasks: [],
          events: [],
          now: () => NOW,
        }}
      />,
    );
    await flush();
    expect(lastFrame() ?? '').toContain(ANALYTICS_SECTION_DIVIDER);
  });

  it('renders 24h decisions count + avg time-to-decision (AC#5, #9)', async () => {
    const { lastFrame } = render(
      <AnalyticsPane
        hookOpts={{
          decisionsReader: () => ({
            records: [decision({ durationMs: 60 * 60 * 1000 })],
            error: null,
          }),
          reliabilityReader: () => NO_RELIABILITY,
          tasks: [],
          events: [],
          now: () => NOW,
        }}
      />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Decisions resolved (24h):');
    expect(frame).toContain('1');
    expect(frame).toContain('Avg time-to-decision:');
    expect(frame).toContain('1.0h');
  });

  it('renders reliability trend "no data" when source missing (AC#8)', async () => {
    const { lastFrame } = render(
      <AnalyticsPane
        hookOpts={{
          decisionsReader: () => ({ records: [], error: null }),
          reliabilityReader: () => NO_RELIABILITY,
          tasks: [],
          events: [],
          now: () => NOW,
        }}
      />,
    );
    await flush();
    expect(lastFrame() ?? '').toContain('no data');
  });

  it('renders reliability trend with delta when source is available (AC#8)', async () => {
    const { lastFrame } = render(
      <AnalyticsPane
        hookOpts={{
          decisionsReader: () => ({ records: [], error: null }),
          reliabilityReader: () => RELIABILITY_AVAILABLE,
          tasks: [],
          events: [],
          now: () => NOW,
        }}
      />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 captures');
    expect(frame).toContain('-3');
  });

  it('renders all four pipeline counters (dispatched / merged / failed / quarantined)', async () => {
    const events: OrchestratorEvent[] = [
      event('OrchestratorDispatched', 60_000),
      event('OrchestratorCompleted', 120_000),
      event('OrchestratorFailed', 180_000),
      event('OrchestratorWorkQuarantined', 240_000),
    ];
    const { lastFrame } = render(
      <AnalyticsPane
        hookOpts={{
          decisionsReader: () => ({ records: [], error: null }),
          reliabilityReader: () => NO_RELIABILITY,
          tasks: [],
          events,
          now: () => NOW,
        }}
      />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Dispatched:');
    expect(frame).toContain('Merged:');
    expect(frame).toContain('Failed:');
    expect(frame).toContain('Quarantined:');
  });
});
