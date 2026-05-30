/**
 * Profiling instrumentation tests (AISDLC-479).
 *
 * Covers (hermetic — tmpdir + injected clock + flag override):
 *   - `computeDurationMs` happy path + clock-skew + unparseable.
 *   - `populateVerdictTiming` populates dispatchedAt/completedAt/durationMs
 *     without mutating the input (AC-2).
 *   - `emitTaskCompletion` / `emitTaskFailure` write the right event type +
 *     respect the orchestrator flag gate (AC-1, AC-7).
 *   - `writeTimedVerdict` writes a timed verdict to the board AND emits the
 *     matching completion/failure event (AC-1 + AC-2).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectVerdicts } from '../dispatch/board.js';
import type { DispatchManifest, DispatchVerdict } from '../dispatch/types.js';
import { eventsFilePath } from './events.js';
import {
  computeDurationMs,
  emitTaskCompletion,
  emitTaskFailure,
  isCompletionOutcome,
  populateVerdictTiming,
  writeTimedVerdict,
} from './profiling.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'profiling-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function manifest(overrides: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId: 'AISDLC-479',
    branch: 'ai-sdlc/aisdlc-479',
    worktree: '.worktrees/aisdlc-479',
    baseSha: 'abcdef1',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-29T00:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm test'] },
    ...overrides,
  };
}

function verdict(overrides: Partial<DispatchVerdict> = {}): DispatchVerdict {
  return {
    schemaVersion: 'v1',
    taskId: 'AISDLC-479',
    outcome: 'success',
    completedAt: '2026-05-29T00:05:00.000Z',
    workerId: 'worker-test',
    ...overrides,
  };
}

describe('computeDurationMs', () => {
  it('returns the millisecond delta for a valid pair', () => {
    expect(computeDurationMs('2026-05-29T00:00:00.000Z', '2026-05-29T00:05:00.000Z')).toBe(300_000);
  });

  it('returns undefined on negative delta (clock skew)', () => {
    expect(
      computeDurationMs('2026-05-29T00:05:00.000Z', '2026-05-29T00:00:00.000Z'),
    ).toBeUndefined();
  });

  it('returns undefined on unparseable timestamps', () => {
    expect(computeDurationMs('not-a-date', '2026-05-29T00:00:00.000Z')).toBeUndefined();
    expect(computeDurationMs('2026-05-29T00:00:00.000Z', 'nope')).toBeUndefined();
  });
});

describe('isCompletionOutcome', () => {
  it('treats success/iterate-needed/approved as completions', () => {
    expect(isCompletionOutcome('success')).toBe(true);
    expect(isCompletionOutcome('iterate-needed')).toBe(true);
    expect(isCompletionOutcome('approved')).toBe(true);
  });
  it('treats failure outcomes as non-completions', () => {
    expect(isCompletionOutcome('failed')).toBe(false);
    expect(isCompletionOutcome('blocked')).toBe(false);
    expect(isCompletionOutcome('quota-exhausted')).toBe(false);
    expect(isCompletionOutcome('iteration-exhausted')).toBe(false);
  });
});

describe('populateVerdictTiming (AC-2)', () => {
  it('populates dispatchedAt/completedAt/durationMs from the manifest', () => {
    const v = verdict();
    const out = populateVerdictTiming(v, { manifest: manifest() });
    expect(out.dispatchedAt).toBe('2026-05-29T00:00:00.000Z');
    expect(out.completedAt).toBe('2026-05-29T00:05:00.000Z');
    expect(out.durationMs).toBe(300_000);
  });

  it('does not mutate the input verdict', () => {
    const v = verdict();
    populateVerdictTiming(v, { manifest: manifest() });
    expect(v.dispatchedAt).toBeUndefined();
    expect(v.durationMs).toBeUndefined();
  });

  it('falls back to the injected clock when completedAt is absent/invalid', () => {
    const v = verdict({ completedAt: '' });
    const out = populateVerdictTiming(v, {
      manifest: manifest(),
      now: () => new Date('2026-05-29T00:10:00.000Z'),
    });
    expect(out.completedAt).toBe('2026-05-29T00:10:00.000Z');
    expect(out.durationMs).toBe(600_000);
  });

  it('leaves durationMs unset on clock skew', () => {
    const v = verdict({ completedAt: '2026-05-28T23:00:00.000Z' });
    const out = populateVerdictTiming(v, { manifest: manifest() });
    expect(out.durationMs).toBeUndefined();
  });
});

describe('emitTaskCompletion / emitTaskFailure (AC-1, AC-7)', () => {
  it('writes an OrchestratorCompleted event when enabled', () => {
    const date = new Date('2026-05-29T00:05:00.000Z');
    const ok = emitTaskCompletion({
      taskId: 'AISDLC-479',
      outcome: 'success',
      durationMs: 300_000,
      artifactsDir: workdir,
      now: () => date,
      isEnabled: () => true,
    });
    expect(ok).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe('OrchestratorCompleted');
    expect(parsed.taskId).toBe('AISDLC-479');
    expect(parsed.durationMs).toBe(300_000);
    expect(parsed.outcome).toBe('success');
    expect(parsed.ts).toBe('2026-05-29T00:05:00.000Z');
  });

  it('writes an OrchestratorFailed event when enabled', () => {
    const date = new Date('2026-05-29T00:05:00.000Z');
    const ok = emitTaskFailure({
      taskId: 'AISDLC-479',
      outcome: 'failed',
      durationMs: 42,
      artifactsDir: workdir,
      now: () => date,
      isEnabled: () => true,
    });
    expect(ok).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    expect(JSON.parse(raw).type).toBe('OrchestratorFailed');
  });

  it('is a no-op when the orchestrator flag is off (AC-7)', () => {
    const date = new Date('2026-05-29T00:05:00.000Z');
    const ok = emitTaskCompletion({
      taskId: 'AISDLC-479',
      outcome: 'success',
      durationMs: 1,
      artifactsDir: workdir,
      now: () => date,
      isEnabled: () => false,
    });
    expect(ok).toBe(false);
    expect(existsSync(eventsFilePath(workdir, date))).toBe(false);
  });

  it('omits durationMs from the event when not provided', () => {
    const date = new Date('2026-05-29T00:05:00.000Z');
    emitTaskCompletion({
      taskId: 'AISDLC-479',
      outcome: 'success',
      artifactsDir: workdir,
      now: () => date,
      isEnabled: () => true,
    });
    const parsed = JSON.parse(readFileSync(eventsFilePath(workdir, date), 'utf8').trim());
    expect('durationMs' in parsed).toBe(false);
  });
});

describe('writeTimedVerdict (AC-1 + AC-2)', () => {
  it('writes a timed verdict to the board and emits a completion event', () => {
    const boardDir = join(workdir, 'dispatch');
    const date = new Date('2026-05-29T00:05:00.000Z');
    const result = writeTimedVerdict({
      boardDir,
      verdict: verdict(),
      manifest: manifest(),
      now: () => date,
      artifactsDir: workdir,
      isEnabled: () => true,
    });

    // Verdict timing is populated.
    expect(result.verdict.dispatchedAt).toBe('2026-05-29T00:00:00.000Z');
    expect(result.verdict.durationMs).toBe(300_000);

    // Verdict landed in done/.
    const landed = collectVerdicts(boardDir);
    expect(landed).toHaveLength(1);
    expect(landed[0]!.durationMs).toBe(300_000);
    expect(landed[0]!.dispatchedAt).toBe('2026-05-29T00:00:00.000Z');

    // Completion event emitted.
    expect(result.eventEmitted).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    expect(JSON.parse(raw).type).toBe('OrchestratorCompleted');
  });

  it('emits an OrchestratorFailed event for a failed verdict', () => {
    const boardDir = join(workdir, 'dispatch');
    const date = new Date('2026-05-29T00:05:00.000Z');
    const result = writeTimedVerdict({
      boardDir,
      verdict: verdict({ outcome: 'failed', commitSha: null }),
      manifest: manifest(),
      now: () => date,
      artifactsDir: workdir,
      isEnabled: () => true,
    });
    expect(result.eventEmitted).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    expect(JSON.parse(raw).type).toBe('OrchestratorFailed');
  });

  it('writes the verdict but emits no event when the flag is off (AC-7)', () => {
    const boardDir = join(workdir, 'dispatch');
    const date = new Date('2026-05-29T00:05:00.000Z');
    const result = writeTimedVerdict({
      boardDir,
      verdict: verdict(),
      manifest: manifest(),
      now: () => date,
      artifactsDir: workdir,
      isEnabled: () => false,
    });
    expect(result.eventEmitted).toBe(false);
    // Verdict still written (verdict file is flag-independent).
    expect(collectVerdicts(boardDir)).toHaveLength(1);
    expect(existsSync(eventsFilePath(workdir, date))).toBe(false);
  });
});
