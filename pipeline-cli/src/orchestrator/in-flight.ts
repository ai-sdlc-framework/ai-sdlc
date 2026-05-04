/**
 * In-flight dispatch tracker (RFC-0015 / AISDLC-179).
 *
 * The tick loop polls the frontier independently each tick. With
 * `maxConcurrent: 1` and a 30s tick interval, every subsequent tick re-picks
 * the same task while tick 1's dev subagent is still mid-flight — wasting
 * dispatches and corrupting worktree state with "branch already exists"
 * collisions.
 *
 * This module owns the in-memory map of `taskId → DispatchState` consulted
 * by the orchestrator's pre-dispatch filter. Tasks already mid-dispatch are
 * silently skipped (with an `OrchestratorTaskAlreadyInFlight` event so
 * operators have a forensic trace) until the existing dispatch settles.
 *
 * Restart-recovery: on cold start the loop reconstructs the map from the
 * filesystem by walking `<workDir>/.worktrees/&star;/.active-task` sentinels —
 * each one represents an in-flight dispatch from a previous orchestrator
 * process. Without this, a restart after a crash would re-dispatch
 * everything that was running before, repeating the original bug at
 * restart-storm scale.
 *
 * Pure module: only reads from disk via `node:fs`. No git / network calls.
 *
 * @module orchestrator/in-flight
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-task dispatch state stored in the in-flight map. The orchestrator
 * loop populates `dispatchPromise` when it kicks off a fresh dispatch;
 * restart-recovery entries leave it `null` because the originating
 * promise belongs to the previous (now-dead) process.
 */
export interface DispatchState {
  /** ISO-8601 timestamp the dispatch was claimed (or sentinel mtime on restart). */
  startedAt: string;
  /** Path to the worktree backing this dispatch. */
  worktreePath: string;
  /**
   * In-process promise the loop is awaiting. Null when the entry was
   * reconstructed from a sentinel (previous-process dispatch).
   */
  dispatchPromise: Promise<unknown> | null;
}

/**
 * Mutable map shared across ticks via the adapters bag. Keyed by
 * lowercase task ID for case-insensitive lookups (matches the rest of
 * the orchestrator's task-ID handling convention).
 */
export type InFlightMap = Map<string, DispatchState>;

/** Build a fresh, empty in-flight map. */
export function makeInFlightMap(): InFlightMap {
  return new Map<string, DispatchState>();
}

/**
 * Walk `<workDir>/.worktrees/&star;/.active-task` and return one
 * DispatchState per sentinel found. Used by `runOrchestratorLoop()` on
 * cold start to reconstruct the in-flight map so a restart doesn't
 * re-dispatch tasks whose worktrees are still around from the previous
 * process.
 *
 * Sentinel format: a one-line text file containing the canonical task ID
 * (per `pipeline-cli/src/steps/04-flip-status.ts`). Best-effort by
 * design — a malformed sentinel produces no entry rather than crashing
 * the loop start (the operator can clean it up via `/ai-sdlc cleanup`).
 *
 * Returns an empty array when the worktrees directory is absent. The
 * `startedAt` field is the sentinel's mtime so operators can correlate
 * the in-flight entry with the originating dispatch's wall-clock time.
 */
export function reconstructInFlightFromWorktrees(workDir: string): InFlightMap {
  const out = makeInFlightMap();
  const root = join(workDir, '.worktrees');
  if (!existsSync(root)) return out;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }

  for (const name of entries) {
    const worktreePath = join(root, name);
    const sentinelPath = join(worktreePath, '.active-task');
    if (!existsSync(sentinelPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(sentinelPath, 'utf8');
    } catch {
      continue;
    }
    const taskId = raw.trim();
    if (!taskId) continue;
    let mtimeIso: string;
    try {
      mtimeIso = statSync(sentinelPath).mtime.toISOString();
    } catch {
      // Sentinel vanished between readdir + stat — skip silently.
      continue;
    }
    const key = taskId.toLowerCase();
    // Idempotent: if two sentinels claim the same task ID (rare data bug),
    // prefer the older one — it was the original dispatch.
    const existing = out.get(key);
    if (existing && existing.startedAt <= mtimeIso) continue;
    out.set(key, {
      startedAt: mtimeIso,
      worktreePath,
      dispatchPromise: null,
    });
  }

  return out;
}

/**
 * Predicate consulted by the orchestrator's pre-dispatch filter. Returns
 * the existing dispatch state when the candidate is in-flight, or
 * `undefined` otherwise.
 */
export function isInFlight(map: InFlightMap, taskId: string): DispatchState | undefined {
  return map.get(taskId.toLowerCase());
}

/**
 * Claim a fresh dispatch slot. Idempotent: if the task is already
 * in-flight (e.g. concurrent ticks racing) the existing entry wins and
 * the caller should skip dispatch. Returns the entry that's authoritative
 * after the claim attempt + a boolean indicating whether THIS call won.
 */
export function claimInFlight(
  map: InFlightMap,
  taskId: string,
  state: DispatchState,
): { claimed: boolean; entry: DispatchState } {
  const key = taskId.toLowerCase();
  const existing = map.get(key);
  if (existing) return { claimed: false, entry: existing };
  map.set(key, state);
  return { claimed: true, entry: state };
}

/**
 * Release a dispatch slot. Called from the loop's try/finally wrapper
 * around every dispatch so the slot is freed on success OR failure.
 * No-op if the entry is already gone (defensive).
 */
export function releaseInFlight(map: InFlightMap, taskId: string): void {
  map.delete(taskId.toLowerCase());
}
