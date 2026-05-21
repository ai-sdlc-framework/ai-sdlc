/**
 * Tests for the cost-warning helper (AISDLC-377.3 — AC #7).
 *
 * Covered:
 *   - Default estimate (no calibration data → $0.20).
 *   - Calibrated estimate from ≥CALIBRATION_FLOOR verdicts with durationMs.
 *   - Outlier clamp (single very long verdict can't blow up the average
 *     past $1.00).
 *   - Floor ($0.05 minimum so we never advertise "free").
 *   - `maybeEmitCostWarning` fires exactly once per session.
 *   - `maybeEmitCostWarning` no-ops on `in-session-agent` workerKind.
 *   - `maybeEmitCostWarning` no-ops when `suppressCostWarning` is true.
 *   - `isSupervisorMissing` truth table.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { claimNext, ensureBoardDirs, writeManifest, writeVerdict } from './board.js';
import {
  CALIBRATION_FLOOR,
  createCostWarningState,
  DEFAULT_PER_TASK_USD,
  estimateClaudePShellCost,
  formatCostWarning,
  isSupervisorMissing,
  maybeEmitCostWarning,
} from './cost-estimate.js';
import type { DispatchManifest, DispatchVerdict } from './types.js';

function mkBoard(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'sup-cost-')), 'dispatch');
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkManifest(taskId: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc',
    workerKind: 'claude-p-shell',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`,
      verifyCommands: ['pnpm test'],
    },
  };
}

function plantShellVerdict(boardDir: string, taskId: string, durationMs: number): void {
  // Set up a complete lifecycle so writeVerdict doesn't error on missing
  // inflight artifacts (it's tolerant, but cleaner to do it right).
  writeManifest(boardDir, mkManifest(taskId));
  claimNext(boardDir, 'claude-p-shell');
  const verdict: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId,
    outcome: 'success',
    completedAt: new Date().toISOString(),
    workerId: 'mock',
    workerKind: 'claude-p-shell',
    durationMs,
  };
  writeVerdict(boardDir, verdict);
}

describe('estimateClaudePShellCost', () => {
  it('returns the default estimate when no claude-p-shell verdicts exist', () => {
    const boardDir = mkBoard();
    const result = estimateClaudePShellCost(boardDir);
    expect(result.calibrated).toBe(false);
    expect(result.perTaskUsd).toBe(DEFAULT_PER_TASK_USD);
    expect(result.sampleSize).toBe(0);
  });

  it('returns the default estimate when fewer than CALIBRATION_FLOOR shell verdicts exist', () => {
    const boardDir = mkBoard();
    for (let i = 0; i < CALIBRATION_FLOOR - 1; i++) {
      plantShellVerdict(boardDir, `AISDLC-COST-${i}`, 600_000);
    }
    const result = estimateClaudePShellCost(boardDir);
    expect(result.calibrated).toBe(false);
    expect(result.sampleSize).toBeLessThan(CALIBRATION_FLOOR);
    expect(result.perTaskUsd).toBe(DEFAULT_PER_TASK_USD);
  });

  it('returns a calibrated estimate when ≥CALIBRATION_FLOOR shell verdicts exist', () => {
    const boardDir = mkBoard();
    // 3 verdicts averaging 30 min each — 0.5h × $0.40 = $0.20.
    for (let i = 0; i < CALIBRATION_FLOOR; i++) {
      plantShellVerdict(boardDir, `AISDLC-CAL-${i}`, 30 * 60_000);
    }
    const result = estimateClaudePShellCost(boardDir);
    expect(result.calibrated).toBe(true);
    expect(result.sampleSize).toBe(CALIBRATION_FLOOR);
    // Expected ≈ $0.20.
    expect(result.perTaskUsd).toBeCloseTo(0.2, 2);
  });

  it('clamps the calibrated estimate at $1.00 per task even with huge outliers', () => {
    const boardDir = mkBoard();
    // 3 verdicts averaging 100 hours each — would be $40 without clamp.
    for (let i = 0; i < CALIBRATION_FLOOR; i++) {
      plantShellVerdict(boardDir, `AISDLC-OUTLIER-${i}`, 100 * 60 * 60_000);
    }
    const result = estimateClaudePShellCost(boardDir);
    expect(result.calibrated).toBe(true);
    expect(result.perTaskUsd).toBeLessThanOrEqual(1.0);
  });

  it('floors the calibrated estimate at $0.05 even when durations are tiny', () => {
    const boardDir = mkBoard();
    // 3 verdicts averaging 1 minute each — would be $0.007 without floor.
    for (let i = 0; i < CALIBRATION_FLOOR; i++) {
      plantShellVerdict(boardDir, `AISDLC-MICRO-${i}`, 60_000);
    }
    const result = estimateClaudePShellCost(boardDir);
    expect(result.calibrated).toBe(true);
    expect(result.perTaskUsd).toBeGreaterThanOrEqual(0.05);
  });

  it('ignores in-session-agent verdicts in the calibration sample', () => {
    const boardDir = mkBoard();
    // Plant lots of in-session-agent verdicts — should be ignored.
    ensureBoardDirs(boardDir);
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        path.join(boardDir, 'done', `AISDLC-INS-${i}.verdict.json`),
        JSON.stringify({
          schemaVersion: 'v1',
          taskId: `AISDLC-INS-${i}`,
          outcome: 'success',
          completedAt: new Date().toISOString(),
          workerId: 'in-session',
          workerKind: 'in-session-agent',
          durationMs: 60_000,
        }),
        'utf-8',
      );
    }
    const result = estimateClaudePShellCost(boardDir);
    expect(result.calibrated).toBe(false);
    expect(result.perTaskUsd).toBe(DEFAULT_PER_TASK_USD);
  });
});

describe('formatCostWarning', () => {
  it('includes the prefix, USD amount, and "default" detail when not calibrated', () => {
    const line = formatCostWarning({
      perTaskUsd: 0.2,
      calibrated: false,
      sampleSize: 0,
      totalDurationMs: 0,
    });
    expect(line).toMatch(/^\[dispatch-cost\]/);
    expect(line).toContain('claude-p-shell');
    expect(line).toContain('Agent SDK credit pool');
    expect(line).toContain('post-2026-06-15');
    expect(line).toContain('$0.20');
    expect(line).toContain('default');
    expect(line).toContain(`${CALIBRATION_FLOOR}`);
  });

  it('includes "calibrated from" + sample size + avg duration when calibrated', () => {
    const line = formatCostWarning({
      perTaskUsd: 0.12,
      calibrated: true,
      sampleSize: 7,
      totalDurationMs: 7 * 18 * 60_000, // 18 min avg
    });
    expect(line).toContain('calibrated from 7 verdicts');
    expect(line).toContain('18 min');
    expect(line).toContain('$0.12');
  });
});

describe('maybeEmitCostWarning', () => {
  it('fires once for the first claude-p-shell manifest in a session', () => {
    const boardDir = mkBoard();
    const state = createCostWarningState();
    const writes: string[] = [];
    const line = maybeEmitCostWarning({
      state,
      workerKind: 'claude-p-shell',
      boardDir,
      write: (l) => writes.push(l),
    });
    expect(line).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(state.fired).toBe(true);
  });

  it('does not fire a second time in the same session', () => {
    const boardDir = mkBoard();
    const state = createCostWarningState();
    const writes: string[] = [];
    maybeEmitCostWarning({
      state,
      workerKind: 'claude-p-shell',
      boardDir,
      write: (l) => writes.push(l),
    });
    maybeEmitCostWarning({
      state,
      workerKind: 'claude-p-shell',
      boardDir,
      write: (l) => writes.push(l),
    });
    expect(writes).toHaveLength(1);
  });

  it('fires on workerKind=any (pessimistic — shell may claim it)', () => {
    const boardDir = mkBoard();
    const state = createCostWarningState();
    const writes: string[] = [];
    maybeEmitCostWarning({
      state,
      workerKind: 'any',
      boardDir,
      write: (l) => writes.push(l),
    });
    expect(writes).toHaveLength(1);
  });

  it('does NOT fire on workerKind=in-session-agent', () => {
    const boardDir = mkBoard();
    const state = createCostWarningState();
    const writes: string[] = [];
    maybeEmitCostWarning({
      state,
      workerKind: 'in-session-agent',
      boardDir,
      write: (l) => writes.push(l),
    });
    expect(writes).toHaveLength(0);
    // Crucially: state.fired stays false, so the next claude-p-shell emit
    // will still trigger the warning.
    expect(state.fired).toBe(false);
  });

  it('does NOT fire when suppressCostWarning is true', () => {
    const boardDir = mkBoard();
    const state = createCostWarningState();
    const writes: string[] = [];
    maybeEmitCostWarning({
      state,
      workerKind: 'claude-p-shell',
      boardDir,
      suppressCostWarning: true,
      write: (l) => writes.push(l),
    });
    expect(writes).toHaveLength(0);
    expect(state.fired).toBe(false);
  });

  it('writes to stderr by default when no write fn provided', () => {
    const boardDir = mkBoard();
    const state = createCostWarningState();
    // Spy on process.stderr.write.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      maybeEmitCostWarning({
        state,
        workerKind: 'claude-p-shell',
        boardDir,
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join('')).toContain('[dispatch-cost]');
  });
});

describe('isSupervisorMissing', () => {
  it('returns false when there is no pending claude-p-shell work', () => {
    expect(
      isSupervisorMissing({
        pendingClaudePShell: 0,
        pidFileExists: false,
        pidLive: false,
      }),
    ).toBe(false);
  });

  it('returns true when pending work exists and no PID file', () => {
    expect(
      isSupervisorMissing({
        pendingClaudePShell: 3,
        pidFileExists: false,
        pidLive: false,
      }),
    ).toBe(true);
  });

  it('returns true when pending work exists, PID file exists, but the owning PID is dead', () => {
    expect(
      isSupervisorMissing({
        pendingClaudePShell: 1,
        pidFileExists: true,
        pidLive: false,
      }),
    ).toBe(true);
  });

  it('returns false when pending work exists and a live PID owns the lock', () => {
    expect(
      isSupervisorMissing({
        pendingClaudePShell: 1,
        pidFileExists: true,
        pidLive: true,
      }),
    ).toBe(false);
  });
});
