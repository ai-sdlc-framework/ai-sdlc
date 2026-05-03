/**
 * Worker state-machine tracker tests (RFC-0015 Phase 2 / AISDLC-169.2).
 *
 * Covers AC #1 (transition events with `{from, to, duration_ms, context}`)
 * and AC #7 (per-worker state file persisted, NOT used for resume).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPersistedWorkerState, WorkerStateTracker } from './index.js';
import type { PersistedWorkerState } from './types.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'orchestrator-state-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('WorkerStateTracker', () => {
  it('emits a WorkerStateTransition event with from/to/duration_ms/context', () => {
    let now = Date.parse('2026-05-02T00:00:00Z');
    const tracker = new WorkerStateTracker({
      workerId: 'w-1',
      taskId: 'AISDLC-X',
      branch: 'ai-sdlc/x',
      worktreePath: '/tmp',
      inMemoryOnly: true,
      now: () => new Date(now),
    });
    now += 5_000;
    const ev = tracker.transition('REVIEW_RUNNING', { note: 'verify passed' });
    expect(ev).not.toBeNull();
    expect(ev!.event).toBe('WorkerStateTransition');
    expect(ev!.from).toBe('DEV_RUNNING');
    expect(ev!.to).toBe('REVIEW_RUNNING');
    expect(ev!.duration_ms).toBe(5_000);
    expect(ev!.context).toEqual({ note: 'verify passed' });
  });

  it('no-ops a transition into the same state', () => {
    const tracker = new WorkerStateTracker({
      workerId: 'w-1',
      taskId: 'AISDLC-X',
      branch: 'ai-sdlc/x',
      worktreePath: '/tmp',
      inMemoryOnly: true,
    });
    expect(tracker.transition('DEV_RUNNING')).toBeNull();
    expect(tracker.emittedEvents).toHaveLength(0);
  });

  it('persists state to <artifactsDir>/_orchestrator/workers/<id>.state.json', () => {
    const tracker = new WorkerStateTracker({
      workerId: 'w-persist',
      taskId: 'AISDLC-Y',
      branch: 'ai-sdlc/y',
      worktreePath: '/tmp',
      artifactsDir: workdir,
    });
    tracker.transition('REVIEW_RUNNING', { note: 'verify passed' });
    tracker.transition('FINALIZING');
    const path = join(workdir, '_orchestrator', 'workers', 'w-persist.state.json');
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as PersistedWorkerState;
    expect(persisted.state).toBe('FINALIZING');
    expect(persisted.history).toHaveLength(2);
    expect(persisted.history[0]!.from).toBe('DEV_RUNNING');
    expect(persisted.history[0]!.to).toBe('REVIEW_RUNNING');
  });

  it('records lastFailure for forensic inspection', () => {
    const tracker = new WorkerStateTracker({
      workerId: 'w-fail',
      taskId: 'AISDLC-Z',
      branch: 'ai-sdlc/z',
      worktreePath: '/tmp',
      artifactsDir: workdir,
    });
    tracker.recordFailure('SecretScanBlocked', 2, 'reformat failed');
    const persisted = readPersistedWorkerState('w-fail', workdir);
    expect(persisted?.lastFailure?.mode).toBe('SecretScanBlocked');
    expect(persisted?.lastFailure?.attempts).toBe(2);
  });

  it('caps history length to keep file bounded', () => {
    const tracker = new WorkerStateTracker({
      workerId: 'w-cap',
      taskId: 'AISDLC-CAP',
      branch: 'ai-sdlc/cap',
      worktreePath: '/tmp',
      inMemoryOnly: true,
      historyLimit: 3,
    });
    tracker.transition('REVIEW_RUNNING');
    tracker.transition('FINALIZING');
    tracker.transition('DONE');
    tracker.transition('NEEDS_HUMAN_ATTENTION');
    expect(tracker.transitionHistory).toHaveLength(3);
    // Oldest dropped — first surviving entry's `from` is the second
    // transition's previous state (REVIEW_RUNNING → FINALIZING).
    expect(tracker.transitionHistory[0]!.from).toBe('REVIEW_RUNNING');
  });
});

describe('readPersistedWorkerState', () => {
  it('returns null when file missing (per Q2 — no resume from state)', () => {
    expect(readPersistedWorkerState('w-missing', workdir)).toBeNull();
  });
});
