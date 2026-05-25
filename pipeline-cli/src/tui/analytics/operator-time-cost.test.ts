/**
 * Tests for RFC-0025 §7.1 / OQ-9 — instrumented operator-time-cost.
 * Phase 5 (AISDLC-306).
 *
 * Asserts:
 *   - blocked / action span pairing
 *   - AFK noise filter (gaps > threshold are zeroed)
 *   - qualitative bucket classification
 *   - per-org config loaded from `quality-monitoring.yaml`
 *   - RFC-0035 §7 fatigue-signal composition (Phase 7 / AISDLC-291): false
 *     when no workDir is supplied; reads operator-state.yaml when it is
 *   - §7 severity rubric format helper
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTION_EVENT_TYPES,
  BLOCKED_EVENT_TYPES,
  classifyActiveCostBucket,
  computeOperatorTimeCost,
  formatOperatorTimeCostForRubric,
  resolveAfkInactivityMinutes,
} from './operator-time-cost.js';

let workdir: string;
let artifactsDir: string;
let eventsDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'op-time-cost-'));
  artifactsDir = join(workdir, 'artifacts');
  eventsDir = join(artifactsDir, '_orchestrator');
  mkdirSync(eventsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

interface RawEvent {
  ts: string;
  type: string;
  taskId?: string;
}

function writeEventsFile(dateStr: string, events: RawEvent[]): void {
  const path = join(eventsDir, `events-${dateStr}.jsonl`);
  const body = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  writeFileSync(path, body, 'utf8');
}

// ── Event-type sets ───────────────────────────────────────────────────

describe('BLOCKED_EVENT_TYPES / ACTION_EVENT_TYPES', () => {
  it('blocked set includes the six RFC-0015 blocker types', () => {
    expect(BLOCKED_EVENT_TYPES.has('OrchestratorBlockedByDor')).toBe(true);
    expect(BLOCKED_EVENT_TYPES.has('OrchestratorBlockedByDependency')).toBe(true);
    expect(BLOCKED_EVENT_TYPES.has('OrchestratorBlockedByDispatchability')).toBe(true);
    expect(BLOCKED_EVENT_TYPES.has('OrchestratorBlockedByBlastRadiusOverlap')).toBe(true);
    expect(BLOCKED_EVENT_TYPES.has('OrchestratorBlockedByOpenPullRequest')).toBe(true);
    expect(BLOCKED_EVENT_TYPES.has('OrchestratorStuckCandidate')).toBe(true);
  });

  it('action set includes the three OperatorActionTaken-class events', () => {
    expect(ACTION_EVENT_TYPES.has('OrchestratorDispatched')).toBe(true);
    expect(ACTION_EVENT_TYPES.has('OrchestratorCompleted')).toBe(true);
    expect(ACTION_EVENT_TYPES.has('OrchestratorRollback')).toBe(true);
  });
});

// ── Bucket classifier ─────────────────────────────────────────────────

describe('classifyActiveCostBucket', () => {
  it('returns "low" for null (no data)', () => {
    expect(classifyActiveCostBucket(null)).toBe('low');
  });

  it('returns "low" for under 5 minutes', () => {
    expect(classifyActiveCostBucket(60 * 1000)).toBe('low');
    expect(classifyActiveCostBucket(4 * 60 * 1000)).toBe('low');
  });

  it('returns "medium" for 5–30 minutes', () => {
    expect(classifyActiveCostBucket(5 * 60 * 1000)).toBe('medium');
    expect(classifyActiveCostBucket(15 * 60 * 1000)).toBe('medium');
    expect(classifyActiveCostBucket(29 * 60 * 1000)).toBe('medium');
  });

  it('returns "high" for 30+ minutes', () => {
    expect(classifyActiveCostBucket(30 * 60 * 1000)).toBe('high');
    expect(classifyActiveCostBucket(60 * 60 * 1000)).toBe('high');
  });
});

// ── computeOperatorTimeCost ───────────────────────────────────────────

describe('computeOperatorTimeCost', () => {
  it('returns empty metrics when no events.jsonl files exist', () => {
    rmSync(eventsDir, { recursive: true, force: true });
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.entries).toEqual([]);
    expect(metrics.meanActiveCostMs).toBeNull();
    expect(metrics.resolvedCount).toBe(0);
    expect(metrics.unresolvedCount).toBe(0);
    expect(metrics.rfc0035FatigueSignal).toBe(false);
  });

  it('pairs a blocked event with the next action event for the same taskId', () => {
    // Block + action 3 minutes apart → active cost = 180_000 ms (under AFK 30 min)
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-100' },
      { ts: '2026-05-24T10:03:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-100' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.entries).toHaveLength(1);
    expect(metrics.entries[0]?.wallClockMs).toBe(3 * 60 * 1000);
    expect(metrics.entries[0]?.activeCostMs).toBe(3 * 60 * 1000);
    expect(metrics.resolvedCount).toBe(1);
    expect(metrics.unresolvedCount).toBe(0);
  });

  it('filters AFK gaps (>30 min default) out of active cost', () => {
    // Block at 10:00, action at 12:00 — 2-hour gap → entire span is one AFK interval
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-101' },
      { ts: '2026-05-24T12:00:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-101' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.entries[0]?.wallClockMs).toBe(2 * 60 * 60 * 1000);
    // 2-hour single interval > 30-min AFK → zeroed
    expect(metrics.entries[0]?.activeCostMs).toBe(0);
  });

  it('honors a custom afkInactivityMinutes option', () => {
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-102' },
      { ts: '2026-05-24T10:10:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-102' },
    ]);
    // 10-min interval with afk=5 → zeroed; with afk=30 → counted
    const tight = computeOperatorTimeCost({ artifactsDir, afkInactivityMinutes: 5 });
    expect(tight.entries[0]?.activeCostMs).toBe(0);

    const lenient = computeOperatorTimeCost({ artifactsDir, afkInactivityMinutes: 30 });
    expect(lenient.entries[0]?.activeCostMs).toBe(10 * 60 * 1000);
  });

  it('emits unresolved entry when block has no matching action', () => {
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-103' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.entries).toHaveLength(1);
    expect(metrics.entries[0]?.resolvedAt).toBeNull();
    expect(metrics.entries[0]?.wallClockMs).toBeNull();
    expect(metrics.entries[0]?.activeCostMs).toBeNull();
    expect(metrics.unresolvedCount).toBe(1);
    expect(metrics.resolvedCount).toBe(0);
  });

  it('filters by taskId when opts.taskId is provided', () => {
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-104' },
      { ts: '2026-05-24T10:01:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-104' },
      { ts: '2026-05-24T11:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-105' },
      { ts: '2026-05-24T11:02:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-105' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir, taskId: 'AISDLC-105' });
    expect(metrics.entries).toHaveLength(1);
    expect(metrics.entries[0]?.taskId).toBe('AISDLC-105');
  });

  it('aggregates mean active cost across resolved entries and classifies bucket', () => {
    writeEventsFile('2026-05-24', [
      // 6-minute span → medium
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-106' },
      { ts: '2026-05-24T10:06:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-106' },
      // 14-minute span → medium
      { ts: '2026-05-24T11:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-107' },
      { ts: '2026-05-24T11:14:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-107' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.resolvedCount).toBe(2);
    const expectedMean = Math.round((6 * 60 * 1000 + 14 * 60 * 1000) / 2);
    expect(metrics.meanActiveCostMs).toBe(expectedMean);
    expect(metrics.operatorTimeCostBucket).toBe('medium');
  });

  it('rfc0035FatigueSignal is false when no workDir is supplied (Phase 7 default)', () => {
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-108' },
      { ts: '2026-05-24T10:30:01.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-108' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.rfc0035FatigueSignal).toBe(false);
  });

  it('rfc0035FatigueSignal is false when workDir is supplied but no operator-state.yaml exists (Phase 7)', () => {
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-108' },
      { ts: '2026-05-24T10:01:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-108' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir, workDir: workdir });
    expect(metrics.rfc0035FatigueSignal).toBe(false);
  });

  it('rfc0035FatigueSignal reflects operator-declared fatigue (Phase 7 / AISDLC-291)', () => {
    const dotDir = join(workdir, '.ai-sdlc');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(
      join(dotDir, 'operator-state.yaml'),
      ['fatigueActive: true', 'fatigueDeclaredAt: 2026-05-24T19:42:00.000Z'].join('\n'),
    );
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-108' },
      { ts: '2026-05-24T10:01:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-108' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir, workDir: workdir });
    expect(metrics.rfc0035FatigueSignal).toBe(true);
  });

  it('rfc0035FatigueSignal returns to false when fatigueActive: false (cleared)', () => {
    const dotDir = join(workdir, '.ai-sdlc');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, 'operator-state.yaml'), 'fatigueActive: false\n');
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-108' },
      { ts: '2026-05-24T10:01:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-108' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir, workDir: workdir });
    expect(metrics.rfc0035FatigueSignal).toBe(false);
  });

  it('tolerates malformed JSONL lines', () => {
    writeFileSync(
      join(eventsDir, 'events-2026-05-24.jsonl'),
      [
        '{"this is not json',
        JSON.stringify({
          ts: '2026-05-24T10:00:00.000Z',
          type: 'OrchestratorBlockedByDor',
          taskId: 'AISDLC-109',
        }),
        JSON.stringify({
          ts: '2026-05-24T10:01:00.000Z',
          type: 'OrchestratorDispatched',
          taskId: 'AISDLC-109',
        }),
        '',
      ].join('\n'),
    );
    const metrics = computeOperatorTimeCost({ artifactsDir });
    expect(metrics.entries).toHaveLength(1);
    expect(metrics.entries[0]?.activeCostMs).toBe(60 * 1000);
  });
});

// ── Config integration ───────────────────────────────────────────────

describe('resolveAfkInactivityMinutes', () => {
  it('honors explicit opt over yaml + default', () => {
    expect(resolveAfkInactivityMinutes({ afkInactivityMinutes: 45 })).toBe(45);
  });

  it('reads from quality-monitoring.yaml when workDir is supplied', () => {
    const dotDir = join(workdir, '.ai-sdlc');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(
      join(dotDir, 'quality-monitoring.yaml'),
      ['operator-time-cost:', '  afkInactivityMinutes: 15'].join('\n'),
    );
    expect(resolveAfkInactivityMinutes({ workDir: workdir })).toBe(15);
  });

  it('falls back to default 30 when no opt and no yaml', () => {
    expect(resolveAfkInactivityMinutes({ workDir: workdir })).toBe(30);
  });
});

describe('computeOperatorTimeCost — yaml config integration', () => {
  it('uses afkInactivityMinutes from quality-monitoring.yaml when workDir given', () => {
    const dotDir = join(workdir, '.ai-sdlc');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(
      join(dotDir, 'quality-monitoring.yaml'),
      ['operator-time-cost:', '  afkInactivityMinutes: 5'].join('\n'),
    );
    // 10-min interval > 5-min AFK from yaml → zeroed
    writeEventsFile('2026-05-24', [
      { ts: '2026-05-24T10:00:00.000Z', type: 'OrchestratorBlockedByDor', taskId: 'AISDLC-110' },
      { ts: '2026-05-24T10:10:00.000Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-110' },
    ]);
    const metrics = computeOperatorTimeCost({ artifactsDir, workDir: workdir });
    expect(metrics.entries[0]?.activeCostMs).toBe(0);
  });
});

// ── §7 severity rubric format ─────────────────────────────────────────

describe('formatOperatorTimeCostForRubric', () => {
  it('renders bucket + mean active duration + RFC-0035 inactive note when no fatigue', () => {
    const out = formatOperatorTimeCostForRubric({
      entries: [],
      meanActiveCostMs: 8 * 60 * 1000 + 23 * 1000,
      operatorTimeCostBucket: 'medium',
      resolvedCount: 1,
      unresolvedCount: 0,
      rfc0035FatigueSignal: false,
    });
    expect(out).toMatch(/^Operator time cost: medium/);
    expect(out).toMatch(/mean active: 8m 23s/);
    expect(out).toMatch(/RFC-0035 §7 fatigue-signal: inactive/);
  });

  it('renders the fatigue-signal "active" note when fatigue is signalled (Phase 7)', () => {
    const out = formatOperatorTimeCostForRubric({
      entries: [],
      meanActiveCostMs: 4 * 60 * 1000,
      operatorTimeCostBucket: 'low',
      resolvedCount: 1,
      unresolvedCount: 0,
      rfc0035FatigueSignal: true,
    });
    expect(out).toMatch(/RFC-0035 §7 fatigue-signal: active/);
  });

  it('renders "no data" when meanActiveCostMs is null', () => {
    const out = formatOperatorTimeCostForRubric({
      entries: [],
      meanActiveCostMs: null,
      operatorTimeCostBucket: 'low',
      resolvedCount: 0,
      unresolvedCount: 0,
      rfc0035FatigueSignal: false,
    });
    expect(out).toMatch(/no data/);
    expect(out).toMatch(/^Operator time cost: low/);
  });
});
