/**
 * Tests for the operator + pipeline metric computation (AISDLC-178.6
 * AC#5, #6, #8, #9).
 */

import { describe, expect, it } from 'vitest';

import {
  computeOperatorMetrics,
  computePipelineMetrics,
  formatDurationCompact,
  formatReliabilityTrend,
  STALE_CLARIFICATION_THRESHOLD_MS,
} from './metrics.js';
import { NEEDS_CLARIFICATION_STATUS, type DecisionRecord } from './decisions-writer.js';
import type { BacklogTask } from '../sources/backlog-walker.js';
import type { OrchestratorEvent } from '../../orchestrator/events.js';
import type { ReliabilityTrend } from './quality-reader.js';

const NOW = new Date('2026-05-15T12:00:00.000Z');

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
    lastModified: '2026-05-15T11:00:00.000Z',
    extras: {},
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: '2026-05-15T10:00:00.000Z',
    taskId: 'AISDLC-100',
    fromStatus: NEEDS_CLARIFICATION_STATUS,
    toStatus: 'In Progress',
    clarificationPostedAt: '2026-05-15T08:00:00.000Z',
    resolvedAt: '2026-05-15T10:00:00.000Z',
    durationMs: 7_200_000,
    ...overrides,
  };
}

function event(type: OrchestratorEvent['type'], tsOffsetMs = 0): OrchestratorEvent {
  return {
    ts: new Date(NOW.getTime() - tsOffsetMs).toISOString(),
    type,
  };
}

describe('computeOperatorMetrics (AC#5, #9)', () => {
  it('counts decisions resolved in the last 24h only', () => {
    const within24h = decision({ ts: new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString() });
    const stale = decision({ ts: new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString() });
    const m = computeOperatorMetrics([within24h, stale], [], { now: NOW });
    expect(m.decisionsResolved24h).toBe(1);
  });

  it('computes avg time-to-decision from durationMs across in-window records', () => {
    const a = decision({
      ts: new Date(NOW.getTime() - 1_000).toISOString(),
      durationMs: 1_000_000,
    });
    const b = decision({
      ts: new Date(NOW.getTime() - 1_000).toISOString(),
      durationMs: 3_000_000,
    });
    const m = computeOperatorMetrics([a, b], [], { now: NOW });
    expect(m.avgTimeToDecisionMs).toBe(2_000_000);
  });

  it('returns null avg when no decisions resolved in the window (graceful)', () => {
    const m = computeOperatorMetrics([], [], { now: NOW });
    expect(m.avgTimeToDecisionMs).toBeNull();
  });

  it('% WIP blocked on operator: needs-clarification / WIP-tasks', () => {
    const tasks = [
      task({ id: 'A', status: 'In Progress' }),
      task({ id: 'B', status: NEEDS_CLARIFICATION_STATUS }),
      task({ id: 'C', status: 'In Review' }),
      task({ id: 'D', status: 'Done' }), // ignored
      task({ id: 'E', status: 'In Progress', fileLocation: 'completed' }), // ignored
    ];
    const m = computeOperatorMetrics([], tasks, { now: NOW });
    expect(m.pctWipBlockedOnOperator).toBe(33);
  });

  it('% WIP blocked on operator returns 0 when no WIP', () => {
    const m = computeOperatorMetrics([], [task({ status: 'Done' })], { now: NOW });
    expect(m.pctWipBlockedOnOperator).toBe(0);
  });

  it('counts stale captures (Needs Clarification older than threshold)', () => {
    const fresh = task({
      id: 'A',
      status: NEEDS_CLARIFICATION_STATUS,
      lastModified: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    });
    const stale = task({
      id: 'B',
      status: NEEDS_CLARIFICATION_STATUS,
      lastModified: new Date(NOW.getTime() - STALE_CLARIFICATION_THRESHOLD_MS - 1000).toISOString(),
    });
    const m = computeOperatorMetrics([], [fresh, stale], { now: NOW });
    expect(m.staleCapturesCount).toBe(1);
  });
});

describe('computePipelineMetrics (AC#6)', () => {
  const reliability: ReliabilityTrend = { available: false, thisWeek: 0, lastWeek: 0, delta: 0 };

  it('counts orchestrator events by type within 24h', () => {
    const events: OrchestratorEvent[] = [
      event('OrchestratorDispatched', 1 * 60 * 60 * 1000),
      event('OrchestratorDispatched', 2 * 60 * 60 * 1000),
      event('OrchestratorCompleted', 3 * 60 * 60 * 1000),
      event('OrchestratorFailed', 4 * 60 * 60 * 1000),
      event('OrchestratorWorkQuarantined', 5 * 60 * 60 * 1000),
      // > 24h ago — ignored.
      event('OrchestratorDispatched', 25 * 60 * 60 * 1000),
    ];
    const m = computePipelineMetrics(events, reliability, { now: NOW });
    expect(m.dispatched24h).toBe(2);
    expect(m.merged24h).toBe(1);
    expect(m.failed24h).toBe(1);
    expect(m.quarantined24h).toBe(1);
  });

  it('passes the reliability trend through unmodified', () => {
    const m = computePipelineMetrics([], reliability, { now: NOW });
    expect(m.reliability).toBe(reliability);
  });

  it('ignores events without a ts field', () => {
    const evNoTs = { type: 'OrchestratorDispatched' } as unknown as OrchestratorEvent;
    const m = computePipelineMetrics([evNoTs], reliability, { now: NOW });
    expect(m.dispatched24h).toBe(0);
  });
});

describe('formatDurationCompact', () => {
  it('returns em-dash for null', () => {
    expect(formatDurationCompact(null)).toBe('—');
  });
  it('formats seconds / minutes / hours / days', () => {
    expect(formatDurationCompact(45_000)).toBe('45s');
    expect(formatDurationCompact(15 * 60_000)).toBe('15m');
    expect(formatDurationCompact(2.5 * 3_600_000)).toBe('2.5h');
    expect(formatDurationCompact(1.5 * 86_400_000)).toBe('1.5d');
  });
});

describe('formatReliabilityTrend (AC#8 graceful degradation)', () => {
  it('returns "no data" when reliability source is unavailable', () => {
    expect(formatReliabilityTrend({ available: false, thisWeek: 0, lastWeek: 0, delta: 0 })).toBe(
      'no data',
    );
  });

  it('renders the week-over-week delta with arrow + sign', () => {
    expect(
      formatReliabilityTrend({ available: true, thisWeek: 5, lastWeek: 8, delta: -3 }),
    ).toMatch(/↓ -3/);
    expect(formatReliabilityTrend({ available: true, thisWeek: 8, lastWeek: 5, delta: 3 })).toMatch(
      /↑ \+3/,
    );
    expect(formatReliabilityTrend({ available: true, thisWeek: 5, lastWeek: 5, delta: 0 })).toMatch(
      /→ 0/,
    );
  });
});
