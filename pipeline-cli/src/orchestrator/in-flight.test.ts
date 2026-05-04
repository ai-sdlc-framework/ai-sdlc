/**
 * Unit tests for the in-flight dispatch tracker (RFC-0015 / AISDLC-179).
 *
 * Cover the four primitives the orchestrator's pre-dispatch filter +
 * cold-start reconstruction depend on:
 *   - `makeInFlightMap` returns an empty map.
 *   - `claimInFlight` is idempotent on conflict (first claimer wins).
 *   - `isInFlight` round-trips through the map.
 *   - `releaseInFlight` removes the entry (and is a no-op when absent).
 *   - `reconstructInFlightFromWorktrees` walks `<workDir>/.worktrees/&star;/.active-task`
 *     sentinels and rebuilds the map (missing dir = empty, malformed
 *     sentinels skipped silently per the best-effort contract).
 *
 * Hermetic by construction — every test uses `mkdtempSync` for fixture
 * worktree dirs and tears them down afterwards, so the suite leaves no
 * filesystem footprint.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimInFlight,
  isInFlight,
  makeInFlightMap,
  reconstructInFlightFromWorktrees,
  releaseInFlight,
  type DispatchState,
} from './in-flight.js';

function makeState(overrides: Partial<DispatchState> = {}): DispatchState {
  return {
    startedAt: '2026-05-03T10:00:00.000Z',
    worktreePath: '/tmp/wt/aisdlc-1',
    dispatchPromise: null,
    ...overrides,
  };
}

describe('makeInFlightMap', () => {
  it('returns an empty map', () => {
    const map = makeInFlightMap();
    expect(map.size).toBe(0);
    // Sanity check: it's a real Map with the standard iteration protocol.
    expect([...map.entries()]).toEqual([]);
  });
});

describe('claimInFlight + isInFlight + releaseInFlight', () => {
  it('claim adds entry; isInFlight finds it; release removes it', () => {
    const map = makeInFlightMap();
    const state = makeState();
    const result = claimInFlight(map, 'AISDLC-1', state);
    expect(result.claimed).toBe(true);
    expect(result.entry).toEqual(state);
    expect(isInFlight(map, 'AISDLC-1')).toEqual(state);

    releaseInFlight(map, 'AISDLC-1');
    expect(isInFlight(map, 'AISDLC-1')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('isInFlight is case-insensitive on task IDs', () => {
    const map = makeInFlightMap();
    claimInFlight(map, 'AISDLC-42', makeState());
    expect(isInFlight(map, 'AISDLC-42')).toBeDefined();
    expect(isInFlight(map, 'aisdlc-42')).toBeDefined();
    expect(isInFlight(map, 'Aisdlc-42')).toBeDefined();
  });

  it('claim is idempotent — second claim loses, first claimer wins', () => {
    const map = makeInFlightMap();
    const first = makeState({ startedAt: '2026-05-03T10:00:00.000Z' });
    const second = makeState({ startedAt: '2026-05-03T11:00:00.000Z' });
    const r1 = claimInFlight(map, 'AISDLC-1', first);
    const r2 = claimInFlight(map, 'AISDLC-1', second);
    expect(r1.claimed).toBe(true);
    expect(r2.claimed).toBe(false);
    // Returned `entry` on the losing claim is the AUTHORITATIVE existing
    // entry (the original claim's state), not the rejected new state.
    expect(r2.entry).toEqual(first);
    expect(isInFlight(map, 'AISDLC-1')).toEqual(first);
  });

  it('release is a no-op when the entry is already gone', () => {
    const map = makeInFlightMap();
    expect(() => releaseInFlight(map, 'never-claimed')).not.toThrow();
    // Idempotent across repeated releases.
    claimInFlight(map, 'AISDLC-1', makeState());
    releaseInFlight(map, 'AISDLC-1');
    expect(() => releaseInFlight(map, 'AISDLC-1')).not.toThrow();
    expect(map.size).toBe(0);
  });
});

describe('reconstructInFlightFromWorktrees', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aisdlc-179-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns an empty map when the worktrees dir is missing', () => {
    // No `.worktrees/` under workDir — should return empty without throwing.
    const map = reconstructInFlightFromWorktrees(workDir);
    expect(map.size).toBe(0);
  });

  it('returns an empty map when the worktrees dir exists but has no children', () => {
    mkdirSync(join(workDir, '.worktrees'));
    const map = reconstructInFlightFromWorktrees(workDir);
    expect(map.size).toBe(0);
  });

  it('rebuilds entries from `.active-task` sentinels — one per worktree', () => {
    const wtRoot = join(workDir, '.worktrees');
    mkdirSync(wtRoot);
    // Worktree #1 with a sentinel.
    const wt1 = join(wtRoot, 'aisdlc-1');
    mkdirSync(wt1);
    writeFileSync(join(wt1, '.active-task'), 'AISDLC-1\n', 'utf8');
    // Worktree #2 with a sentinel.
    const wt2 = join(wtRoot, 'aisdlc-2');
    mkdirSync(wt2);
    writeFileSync(join(wt2, '.active-task'), 'AISDLC-2', 'utf8');
    // Worktree without a sentinel — should be skipped silently.
    mkdirSync(join(wtRoot, 'aisdlc-no-sentinel'));

    const map = reconstructInFlightFromWorktrees(workDir);
    expect(map.size).toBe(2);
    expect(isInFlight(map, 'AISDLC-1')?.worktreePath).toBe(wt1);
    expect(isInFlight(map, 'AISDLC-2')?.worktreePath).toBe(wt2);
    // The reconstructed entries carry no in-process promise (the originating
    // process is dead by definition on cold start).
    expect(isInFlight(map, 'AISDLC-1')?.dispatchPromise).toBeNull();
    // `startedAt` is the sentinel mtime (best-effort wall-clock anchor for
    // operators correlating with the events bus).
    const startedAt = isInFlight(map, 'AISDLC-1')?.startedAt;
    expect(typeof startedAt).toBe('string');
    expect(() => new Date(startedAt!).toISOString()).not.toThrow();
  });

  it('skips malformed sentinels (empty file) without crashing', () => {
    const wtRoot = join(workDir, '.worktrees');
    mkdirSync(wtRoot);
    const wt = join(wtRoot, 'aisdlc-empty');
    mkdirSync(wt);
    // Empty sentinel — no task ID to claim.
    writeFileSync(join(wt, '.active-task'), '   \n', 'utf8');

    const map = reconstructInFlightFromWorktrees(workDir);
    expect(map.size).toBe(0);
  });

  it('preserves the older entry on duplicate task-id sentinels (rare data bug)', () => {
    const wtRoot = join(workDir, '.worktrees');
    mkdirSync(wtRoot);
    const wtOlder = join(wtRoot, 'aisdlc-1-older');
    mkdirSync(wtOlder);
    writeFileSync(join(wtOlder, '.active-task'), 'AISDLC-1', 'utf8');
    const wtNewer = join(wtRoot, 'aisdlc-1-newer');
    mkdirSync(wtNewer);
    writeFileSync(join(wtNewer, '.active-task'), 'AISDLC-1', 'utf8');

    const map = reconstructInFlightFromWorktrees(workDir);
    // Only one entry survives — duplicate task IDs collapse onto the older
    // (first-dispatched) sentinel per the module's idempotency contract.
    expect(map.size).toBe(1);
    expect(isInFlight(map, 'AISDLC-1')).toBeDefined();
  });
});
