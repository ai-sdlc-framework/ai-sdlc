/**
 * Estimate-log writer tests — RFC-0016 Phase 2 (AISDLC-280).
 *
 * Covers:
 *  - Single capture writes one JSONL row with every required field.
 *  - `runIndex` increments on same-hash repeat captures (ensemble).
 *  - `runIndex` resets to 1 when the hash changes between captures.
 *  - `EstimateInputChanged` event fires on hash transitions only.
 *  - `EstimateCaptured` event fires on every successful capture.
 *  - Events writes are gated by `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` —
 *    the log row still appears when the events flag is off.
 *  - Reader (`readEstimateLog`) returns rows in append order + honours
 *    `taskId` filter + `limit`.
 *  - Best-effort: malformed lines + missing files don't crash.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORCHESTRATOR_FLAG } from '../orchestrator/feature-flag.js';
import { captureEstimate, estimateLogPath, readEstimateLog } from './log-writer.js';
import type { SignalOutput, StageAResult } from './types.js';

const SIGNALS_XS: SignalOutput[] = [
  {
    id: 1,
    name: 'file scope count',
    inputs: { fileCount: 1 },
    result: { kind: 'range', low: 'XS', high: 'S' },
  },
  {
    id: 9,
    name: 'class-default fallback',
    inputs: { taskClass: 'bug', seedBucket: 'S' },
    result: { kind: 'bucket', bucket: 'S' },
  },
];

function buildStageA(overrides: Partial<StageAResult> = {}): StageAResult {
  return {
    taskId: 'AISDLC-123',
    taskClass: 'bug',
    classSource: 'heuristic',
    signals: SIGNALS_XS,
    candidateBucket: 'XS',
    confidence: 'high',
    escalateToStageB: false,
    rationale: '1 cheap-specific signal voted → XS',
    ...overrides,
  };
}

let workdir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'estimate-log-'));
  savedEnv = { ...process.env };
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = savedEnv;
});

describe('captureEstimate — basic capture', () => {
  it('writes one JSONL row with every required field', () => {
    const out = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 'fix: null deref',
      taskDescription: 'crashes when amount is null',
      now: () => new Date('2026-05-16T12:00:00Z'),
      artifactsDir: workdir,
    });
    expect(existsSync(out.logPath)).toBe(true);
    expect(out.logPath).toBe(estimateLogPath(workdir));
    expect(out.record.ts).toBe('2026-05-16T12:00:00.000Z');
    expect(out.record.predictedBy).toBe('stage-a-deterministic');
    expect(out.record.taskId).toBe('AISDLC-123');
    expect(out.record.class).toBe('bug');
    expect(out.record.bucket).toBe('XS');
    expect(out.record.finalBucket).toBe('XS');
    expect(out.record.stageA.signals).toHaveLength(2);
    expect(out.record.stageA.confidence).toBe('high');
    expect(out.record.estimateInputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.record.runIndex).toBe(1);
    expect(out.record.classSource).toBe('heuristic');
    expect(out.record.classCached).toBe(false);
  });

  it('serialises the row as one JSONL line', () => {
    captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const raw = readFileSync(estimateLogPath(workdir), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    // Round-trip parseable.
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it('preserves the candidateRange when Stage A produced a range', () => {
    const result = captureEstimate({
      stageA: buildStageA({
        candidateBucket: 'S',
        candidateRange: { low: 'S', high: 'M' },
        confidence: 'medium',
      }),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(result.record.bucketRange).toEqual({ low: 'S', high: 'M' });
    expect(result.record.stageA.candidateRange).toEqual({ low: 'S', high: 'M' });
  });

  it('honors a custom predictedBy / context / scopeFactors', () => {
    const out = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      predictedBy: 'claude-opus-4-7',
      context: 'dispatch-decision',
      scopeFactors: ['test-only', 'corpus-fixture-already-shipped'],
      artifactsDir: workdir,
    });
    expect(out.record.predictedBy).toBe('claude-opus-4-7');
    expect(out.record.context).toBe('dispatch-decision');
    expect(out.record.scopeFactors).toEqual(['test-only', 'corpus-fixture-already-shipped']);
  });

  it('appends successive captures rather than overwriting', () => {
    captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't1',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    captureEstimate({
      stageA: buildStageA({ taskId: 'AISDLC-456' }),
      taskTitle: 't2',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const rows = readEstimateLog({ artifactsDir: workdir });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.taskId).toBe('AISDLC-123');
    expect(rows[1]!.taskId).toBe('AISDLC-456');
  });
});

describe('captureEstimate — ensemble (same-hash) semantics', () => {
  it('increments runIndex when the same hash is captured again', () => {
    const a = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const b = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const c = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(a.record.runIndex).toBe(1);
    expect(b.record.runIndex).toBe(2);
    expect(c.record.runIndex).toBe(3);
    expect(a.record.estimateInputHash).toBe(b.record.estimateInputHash);
    expect(a.record.estimateInputHash).toBe(c.record.estimateInputHash);
  });

  it('does NOT emit EstimateInputChanged when the hash is unchanged', () => {
    captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const second = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(second.inputChangedEmitted).toBe(false);
  });
});

describe('captureEstimate — hash-transition semantics', () => {
  it('resets runIndex to 1 when the hash changes', () => {
    const a = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't1',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const b = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't2', // changed → different hash
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(a.record.estimateInputHash).not.toBe(b.record.estimateInputHash);
    expect(b.record.runIndex).toBe(1);
  });

  it('emits EstimateInputChanged with the old + new hashes', () => {
    captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't1',
      taskDescription: 'd',
      artifactsDir: workdir,
      now: () => new Date('2026-05-16T12:00:00Z'),
    });
    const transition = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't2',
      taskDescription: 'd',
      artifactsDir: workdir,
      now: () => new Date('2026-05-16T12:01:00Z'),
    });
    expect(transition.inputChangedEmitted).toBe(true);

    // The events writer wrote to <workdir>/_orchestrator/events-YYYY-MM-DD.jsonl.
    const eventsPath = join(workdir, '_orchestrator', 'events-2026-05-16.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const eventLines = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    // Expected sequence: 1st EstimateCaptured (initial), then
    // EstimateInputChanged + EstimateCaptured for the transition.
    expect(eventLines.map((e) => e.type)).toEqual([
      'EstimateCaptured',
      'EstimateInputChanged',
      'EstimateCaptured',
    ]);
  });

  it('does NOT emit EstimateInputChanged on the first capture of a new task', () => {
    const first = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(first.inputChangedEmitted).toBe(false);
  });

  it('hash transitions only across captures of the SAME taskId', () => {
    // Task A's captures don't trigger transitions for Task B.
    captureEstimate({
      stageA: buildStageA({ taskId: 'AISDLC-A' }),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const taskB = captureEstimate({
      stageA: buildStageA({ taskId: 'AISDLC-B' }),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(taskB.inputChangedEmitted).toBe(false);
  });
});

describe('captureEstimate — events.jsonl wiring (RFC-0015)', () => {
  it('writes EstimateCaptured to the orchestrator events file when the flag is set', () => {
    captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
      now: () => new Date('2026-05-16T12:00:00Z'),
    });
    const eventsPath = join(workdir, '_orchestrator', 'events-2026-05-16.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const line = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)[0]!;
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event.type).toBe('EstimateCaptured');
    expect(event.taskId).toBe('AISDLC-123');
    expect(event.bucket).toBe('XS');
    expect(event.finalBucket).toBe('XS');
    expect(event.class).toBe('bug');
    expect(event.runIndex).toBe(1);
    expect(event.confidence).toBe('high');
    expect(event.escalateToStageB).toBe(false);
    expect(typeof event.estimateInputHash).toBe('string');
  });

  it('still writes log.jsonl when AI_SDLC_AUTONOMOUS_ORCHESTRATOR is off', () => {
    // AISDLC-411: post-cutover unset = ON; explicit opt-out via 'off'.
    process.env[ORCHESTRATOR_FLAG] = 'off';
    const out = captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    expect(out.eventEmitted).toBe(false);
    expect(existsSync(out.logPath)).toBe(true);
    expect(existsSync(join(workdir, '_orchestrator'))).toBe(false);
    expect(readEstimateLog({ artifactsDir: workdir })).toHaveLength(1);
  });
});

describe('readEstimateLog', () => {
  it('returns an empty array when the log file is missing', () => {
    expect(readEstimateLog({ artifactsDir: workdir })).toEqual([]);
  });

  it('filters by taskId case-insensitively', () => {
    captureEstimate({
      stageA: buildStageA({ taskId: 'AISDLC-A' }),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    captureEstimate({
      stageA: buildStageA({ taskId: 'AISDLC-B' }),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const aRows = readEstimateLog({ artifactsDir: workdir, taskId: 'aisdlc-a' });
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.taskId).toBe('AISDLC-A');
  });

  it('honors the limit (newest rows last)', () => {
    for (let i = 0; i < 5; i += 1) {
      captureEstimate({
        stageA: buildStageA({ taskId: `AISDLC-${i}` }),
        taskTitle: `t${i}`,
        taskDescription: 'd',
        artifactsDir: workdir,
      });
    }
    const rows = readEstimateLog({ artifactsDir: workdir, limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.taskId)).toEqual(['AISDLC-3', 'AISDLC-4']);
  });

  it('skips malformed lines silently', () => {
    captureEstimate({
      stageA: buildStageA(),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    // Inject a corrupted line between two valid captures.
    const path = estimateLogPath(workdir);
    writeFileSync(path, readFileSync(path, 'utf8') + 'not-json\n', 'utf8');
    captureEstimate({
      stageA: buildStageA({ taskId: 'AISDLC-B' }),
      taskTitle: 't',
      taskDescription: 'd',
      artifactsDir: workdir,
    });
    const rows = readEstimateLog({ artifactsDir: workdir });
    expect(rows.map((r) => r.taskId)).toEqual(['AISDLC-123', 'AISDLC-B']);
  });
});
