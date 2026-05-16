/**
 * Integration test — RFC-0016 Phase 1 + Phase 2 wired end-to-end (AC #5).
 *
 * Confirms the full write path:
 *   1. `runStageA` against a real task file on disk produces a verdict
 *      with all 9 §5.1 signals.
 *   2. The cache returns a cached classification on the second
 *      `runStageA` call (single LLM call per class per repo — AC #3).
 *   3. `captureEstimate` writes the row to `_estimates/log.jsonl`
 *      with `stageA`, `finalBucket`, `estimateInputHash`, and `class`
 *      fields (AC #1 + AC #2).
 *   4. The RFC-0015 `events.jsonl` writer fires an `EstimateCaptured`
 *      event in the same call (AC #4).
 *   5. Re-running the pipeline with the same task body produces a
 *      second log row with `runIndex=2` and the same `estimateInputHash`
 *      — and does NOT emit an `EstimateInputChanged` event (ensemble
 *      semantics, §8.4).
 *
 * Hermetic — every test builds its own tmp project + artifacts dir,
 * and cleans up afterwards.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';
import { ORCHESTRATOR_FLAG } from '../orchestrator/feature-flag.js';
import { assignClassCached } from './cache.js';
import { captureEstimate, estimateLogPath, readEstimateLog } from './log-writer.js';
import { runStageA } from './stage-a.js';

let workDir: string;
let artifactsDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workDir = makeTmpProject();
  artifactsDir = mkdtempSync(join(tmpdir(), 'estimate-artifacts-'));
  savedEnv = { ...process.env };
  // RFC-0015 flag on so the events.jsonl writer fires.
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
  // Route the Phase 2 class-assignment cache (consulted inside
  // runStageA) into the tmp artifacts dir too — otherwise it leaks
  // into the test runner's cwd as `artifacts/_estimates/...`.
  process.env.ARTIFACTS_DIR = artifactsDir;
});

afterEach(() => {
  cleanupTmpProject(workDir);
  rmSync(artifactsDir, { recursive: true, force: true });
  process.env = savedEnv;
});

describe('RFC-0016 Phase 1 + Phase 2 integration', () => {
  it('runs Stage A and captures the result with every required field (AC #1, #2)', () => {
    writeTaskFile(workDir, {
      id: 'AISDLC-INT-1',
      title: 'fix: null deref in PaymentValidator',
      description: 'Restore Auth header propagation through the proxy after middleware refactor',
      references: ['src/auth/PaymentValidator.ts'],
    });

    const stageA = runStageA({ taskId: 'AISDLC-INT-1', workDir });
    const captured = captureEstimate({
      stageA,
      taskTitle: 'fix: null deref in PaymentValidator',
      taskDescription:
        'Restore Auth header propagation through the proxy after middleware refactor',
      artifactsDir,
    });

    expect(existsSync(captured.logPath)).toBe(true);
    expect(captured.logPath).toBe(estimateLogPath(artifactsDir));

    // AC #2 — every required field is present on the persisted row.
    const rows = readEstimateLog({ artifactsDir });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.stageA).toBeDefined();
    expect(row.stageA.signals).toHaveLength(9);
    expect(row.finalBucket).toBeDefined();
    expect(['XS', 'S', 'M', 'L', 'XL']).toContain(row.finalBucket);
    expect(row.estimateInputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(['bug', 'feature', 'chore', 'uncategorized']).toContain(row.class);
    expect(row.class).toBe('bug'); // heuristic on the `fix:` prefix
  });

  it('emits EstimateCaptured on the orchestrator events stream (AC #4)', () => {
    writeTaskFile(workDir, {
      id: 'AISDLC-INT-2',
      title: 'feat: add widget',
      description: 'Adds a new widget surface to the dashboard.',
      references: ['src/dashboard/Widget.tsx'],
    });

    const stageA = runStageA({ taskId: 'AISDLC-INT-2', workDir });
    const captured = captureEstimate({
      stageA,
      taskTitle: 'feat: add widget',
      taskDescription: 'Adds a new widget surface to the dashboard.',
      artifactsDir,
      now: () => new Date('2026-05-16T12:00:00Z'),
    });
    expect(captured.eventEmitted).toBe(true);

    // The events writer rotates daily — events-2026-05-16.jsonl.
    const eventsPath = join(artifactsDir, '_orchestrator', 'events-2026-05-16.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const line = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)[0]!;
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event.type).toBe('EstimateCaptured');
    expect(event.taskId).toBe('AISDLC-INT-2');
    expect(event.class).toBe('feature');
    expect(event.estimateInputHash).toBe(captured.record.estimateInputHash);
  });

  it('caches the class assignment — single call per repo (AC #3)', () => {
    writeTaskFile(workDir, {
      id: 'AISDLC-INT-3',
      title: 'chore: bump @types/node',
      description: 'Bump @types/node from 22.10.0 to 22.10.5',
      references: ['package.json'],
    });

    const assigner = vi.fn(() => ({ taskClass: 'chore' as const, source: 'heuristic' as const }));
    const first = assignClassCached({
      taskId: 'AISDLC-INT-3',
      title: 'chore: bump @types/node',
      description: 'Bump @types/node from 22.10.0 to 22.10.5',
      artifactsDir,
      assigner,
    });
    const second = assignClassCached({
      taskId: 'AISDLC-INT-3',
      title: 'chore: bump @types/node',
      description: 'Bump @types/node from 22.10.0 to 22.10.5',
      artifactsDir,
      assigner,
    });
    // The "LLM call" (heuristic stand-in) ran once; second invocation
    // served the cached row.
    expect(assigner).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.taskClass).toBe('chore');
  });

  it('successive captures of the same hash advance runIndex (ensemble per §8.4)', () => {
    writeTaskFile(workDir, {
      id: 'AISDLC-INT-4',
      title: 'feat: ensemble probe',
      description: 'desc',
      references: ['src/a.ts'],
    });
    const stageA = runStageA({ taskId: 'AISDLC-INT-4', workDir });

    const a = captureEstimate({
      stageA,
      taskTitle: 'feat: ensemble probe',
      taskDescription: 'desc',
      artifactsDir,
    });
    const b = captureEstimate({
      stageA,
      taskTitle: 'feat: ensemble probe',
      taskDescription: 'desc',
      artifactsDir,
    });
    expect(a.record.runIndex).toBe(1);
    expect(b.record.runIndex).toBe(2);
    expect(a.record.estimateInputHash).toBe(b.record.estimateInputHash);
    expect(b.inputChangedEmitted).toBe(false);

    const rows = readEstimateLog({ artifactsDir });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.runIndex)).toEqual([1, 2]);
  });

  it('hash change between captures fires EstimateInputChanged before the new EstimateCaptured', () => {
    writeTaskFile(workDir, {
      id: 'AISDLC-INT-5',
      title: 'feat: original',
      description: 'd',
      references: ['src/a.ts'],
    });
    const stageA1 = runStageA({ taskId: 'AISDLC-INT-5', workDir });
    captureEstimate({
      stageA: stageA1,
      taskTitle: 'feat: original',
      taskDescription: 'd',
      artifactsDir,
      now: () => new Date('2026-05-16T12:00:00Z'),
    });

    const transition = captureEstimate({
      stageA: stageA1,
      taskTitle: 'feat: original',
      taskDescription: 'description was edited mid-flight',
      artifactsDir,
      now: () => new Date('2026-05-16T12:01:00Z'),
    });
    expect(transition.inputChangedEmitted).toBe(true);
    expect(transition.record.runIndex).toBe(1);

    const eventsPath = join(artifactsDir, '_orchestrator', 'events-2026-05-16.jsonl');
    const types = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(['EstimateCaptured', 'EstimateInputChanged', 'EstimateCaptured']);
  });

  it('still writes log.jsonl when the orchestrator events flag is off', () => {
    delete process.env[ORCHESTRATOR_FLAG];
    writeTaskFile(workDir, {
      id: 'AISDLC-INT-6',
      title: 'feat: events-off probe',
      description: 'd',
      references: ['src/a.ts'],
    });
    const stageA = runStageA({ taskId: 'AISDLC-INT-6', workDir });
    const captured = captureEstimate({
      stageA,
      taskTitle: 'feat: events-off probe',
      taskDescription: 'd',
      artifactsDir,
    });
    expect(captured.eventEmitted).toBe(false);
    expect(existsSync(estimateLogPath(artifactsDir))).toBe(true);
    expect(readEstimateLog({ artifactsDir })).toHaveLength(1);
    expect(existsSync(join(artifactsDir, '_orchestrator'))).toBe(false);
  });
});
