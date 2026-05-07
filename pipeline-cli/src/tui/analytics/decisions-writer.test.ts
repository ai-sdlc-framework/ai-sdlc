/**
 * Tests for the decisions writer + transition tracker (AISDLC-178.6 AC#1, #9, #10).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DecisionsTracker,
  NEEDS_CLARIFICATION_STATUS,
  writeDecision,
  type DecisionRecord,
} from './decisions-writer.js';
import { decisionsPath } from './paths.js';
import type { BacklogTask } from '../sources/backlog-walker.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'decisions-writer-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const SAMPLE_RECORD: DecisionRecord = {
  ts: '2026-05-04T10:00:00.000Z',
  taskId: 'AISDLC-100',
  fromStatus: NEEDS_CLARIFICATION_STATUS,
  toStatus: 'In Progress',
  clarificationPostedAt: '2026-05-04T08:00:00.000Z',
  resolvedAt: '2026-05-04T10:00:00.000Z',
  durationMs: 7_200_000,
};

function makeTask(overrides: Partial<BacklogTask> = {}): BacklogTask {
  return {
    id: 'AISDLC-100',
    title: 'sample',
    status: NEEDS_CLARIFICATION_STATUS,
    priority: '',
    labels: [],
    dependencies: [],
    fileLocation: 'open',
    filePath: '/repo/backlog/tasks/aisdlc-100.md',
    lastModified: '2026-05-04T08:00:00.000Z',
    extras: {},
    ...overrides,
  };
}

describe('writeDecision', () => {
  it('appends a JSONL line under <artifactsDir>/_operator/decisions.jsonl', () => {
    const ok = writeDecision(SAMPLE_RECORD, {
      artifactsDir: workdir,
      isEnabled: () => true,
    });
    expect(ok).toBe(true);
    const path = decisionsPath(workdir);
    const raw = readFileSync(path, 'utf8');
    expect(JSON.parse(raw.trim())).toEqual(SAMPLE_RECORD);
  });

  it('returns false (no-op) when telemetry is disabled', () => {
    const ok = writeDecision(SAMPLE_RECORD, {
      artifactsDir: workdir,
      isEnabled: () => false,
    });
    expect(ok).toBe(false);
  });
});

describe('DecisionsTracker', () => {
  it('emits NO records on the first observe (cold-start seed)', () => {
    const tracker = new DecisionsTracker({
      writer: () => true,
      now: () => new Date('2026-05-04T08:00:00.000Z'),
    });
    const emitted = tracker.observe([
      makeTask({ status: NEEDS_CLARIFICATION_STATUS }),
      makeTask({ id: 'AISDLC-101', status: 'In Progress' }),
    ]);
    expect(emitted).toEqual([]);
    expect(tracker.hasSeeded()).toBe(true);
  });

  it('emits a record on Needs Clarification → In Progress transition', () => {
    const writer = vi.fn().mockReturnValue(true);
    const clock = vi.fn();
    clock.mockReturnValueOnce(new Date('2026-05-04T08:00:00.000Z'));
    clock.mockReturnValueOnce(new Date('2026-05-04T10:00:00.000Z'));
    const tracker = new DecisionsTracker({ writer, now: clock });

    // Seed: task is in Needs Clarification.
    tracker.observe([makeTask({ status: NEEDS_CLARIFICATION_STATUS })]);
    // Operator decides — flips to In Progress.
    const emitted = tracker.observe([makeTask({ status: 'In Progress' })]);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      taskId: 'AISDLC-100',
      fromStatus: NEEDS_CLARIFICATION_STATUS,
      toStatus: 'In Progress',
      clarificationPostedAt: '2026-05-04T08:00:00.000Z',
      resolvedAt: '2026-05-04T10:00:00.000Z',
      durationMs: 2 * 60 * 60 * 1000,
    });
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('emits a record on Needs Clarification → any other status (Done, Blocked, etc.)', () => {
    const writer = vi.fn().mockReturnValue(true);
    const clock = vi.fn();
    clock.mockReturnValueOnce(new Date('2026-05-04T08:00:00.000Z'));
    clock.mockReturnValueOnce(new Date('2026-05-04T10:30:00.000Z'));
    const tracker = new DecisionsTracker({ writer, now: clock });
    tracker.observe([makeTask({ status: NEEDS_CLARIFICATION_STATUS })]);
    const emitted = tracker.observe([makeTask({ status: 'Done' })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].toStatus).toBe('Done');
    expect(emitted[0].durationMs).toBe(2.5 * 60 * 60 * 1000);
  });

  it('starts the timer when entry into Needs Clarification is observed mid-flight', () => {
    const writer = vi.fn().mockReturnValue(true);
    const clock = vi.fn();
    clock.mockReturnValueOnce(new Date('2026-05-04T08:00:00.000Z'));
    clock.mockReturnValueOnce(new Date('2026-05-04T09:00:00.000Z'));
    clock.mockReturnValueOnce(new Date('2026-05-04T11:00:00.000Z'));
    const tracker = new DecisionsTracker({ writer, now: clock });

    // Seed: In Progress.
    tracker.observe([makeTask({ status: 'In Progress' })]);
    // Mid-flight: → Needs Clarification (no record emitted).
    let emitted = tracker.observe([makeTask({ status: NEEDS_CLARIFICATION_STATUS })]);
    expect(emitted).toEqual([]);
    // Resolution: → Done.
    emitted = tracker.observe([makeTask({ status: 'Done' })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].clarificationPostedAt).toBe('2026-05-04T09:00:00.000Z');
    expect(emitted[0].resolvedAt).toBe('2026-05-04T11:00:00.000Z');
    expect(emitted[0].durationMs).toBe(2 * 60 * 60 * 1000);
  });

  it('does NOT emit when status changes between non-NeedsClarification states', () => {
    const writer = vi.fn().mockReturnValue(true);
    const tracker = new DecisionsTracker({ writer });
    tracker.observe([makeTask({ status: 'To Do' })]);
    const emitted = tracker.observe([makeTask({ status: 'In Progress' })]);
    expect(emitted).toEqual([]);
    expect(writer).not.toHaveBeenCalled();
  });

  it('routes through writeDecision in the production path (writes to disk)', () => {
    const tracker = new DecisionsTracker({
      artifactsDir: workdir,
      isEnabled: () => true,
    });
    tracker.observe([makeTask({ status: NEEDS_CLARIFICATION_STATUS })]);
    tracker.observe([makeTask({ status: 'In Progress' })]);
    const raw = readFileSync(decisionsPath(workdir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(raw.trim()) as DecisionRecord;
    expect(parsed.toStatus).toBe('In Progress');
  });
});
