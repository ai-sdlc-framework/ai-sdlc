/**
 * Dispatch Board filesystem operations (RFC-0041 §4.4).
 *
 * The board lives under `<projectRoot>/.ai-sdlc/dispatch/` and has four
 * subdirectories that represent the manifest lifecycle:
 *
 *   queue/      manifests written by Conductor, awaiting pickup
 *   inflight/   manifests claimed by a Worker (atomic rename from queue/)
 *   done/       verdicts written by Workers on success
 *   failed/     diagnostics written by Workers (or supervisor) on failure
 *
 * Atomic claim — Workers and the supervisor use `fs.renameSync` on the same
 * filesystem. POSIX guarantees rename atomicity on the same FS, so two
 * Workers racing for the same manifest is safe: one wins, the other gets
 * `ENOENT` and tries the next file.
 *
 * Functions are designed to be import-safe in test scaffolding — they take
 * a `boardDir` argument and never read environment variables directly.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  BOARD_SUBDIRS,
  type ClaimResult,
  type DispatchManifest,
  type DispatchVerdict,
  type InflightHeartbeat,
  type QueueCounts,
  type SweepResult,
  type WorkerKind,
} from './types.js';

/** Default `boardDir` when callers don't override (resolved against cwd). */
export const DEFAULT_BOARD_DIR = '.ai-sdlc/dispatch';

/** Filename suffix the dispatch protocol uses for manifests. */
const MANIFEST_SUFFIX = '.dispatch.json';
/** Filename suffix the dispatch protocol uses for verdicts. */
const VERDICT_SUFFIX = '.verdict.json';
/** Filename suffix the dispatch protocol uses for inflight heartbeat state. */
const STATE_SUFFIX = '.state.json';
/** Filename suffix the dispatch protocol uses for failure diagnostics. */
const DIAGNOSTIC_SUFFIX = '.diagnostic.json';

/** Default heartbeat-stale threshold in milliseconds (RFC-0041 OQ-3 — 30 min). */
export const DEFAULT_HEARTBEAT_STALE_MS = 30 * 60 * 1000;

/**
 * Ensure all four board subdirectories exist. Cheap to call on every
 * Conductor/Worker invocation — `mkdirSync` with `recursive: true` is
 * idempotent.
 */
export function ensureBoardDirs(boardDir: string): void {
  for (const sub of BOARD_SUBDIRS) {
    mkdirSync(path.join(boardDir, sub), { recursive: true });
  }
}

/** Build the absolute path for a manifest in a given subdir. */
function manifestPathIn(boardDir: string, sub: string, taskId: string): string {
  return path.join(boardDir, sub, `${taskId}${MANIFEST_SUFFIX}`);
}

/**
 * Write a manifest into the `queue/` subdir.
 *
 * Uses an atomic write (temp + rename in the same dir) so a partial write
 * is never visible to Worker pollers. Returns the final absolute path.
 *
 * @throws if the destination already exists — the Conductor must not
 *   re-dispatch a task without first releasing the prior inflight entry.
 */
export function writeManifest(boardDir: string, manifest: DispatchManifest): string {
  ensureBoardDirs(boardDir);
  const target = manifestPathIn(boardDir, 'queue', manifest.taskId);
  if (existsSync(target)) {
    throw new Error(
      `dispatch.writeManifest: queue/${manifest.taskId}${MANIFEST_SUFFIX} already exists; release inflight before re-emitting`,
    );
  }
  // Also refuse if already inflight — preserves the invariant that a manifest
  // can only exist in one subdir at a time.
  const inflight = manifestPathIn(boardDir, 'inflight', manifest.taskId);
  if (existsSync(inflight)) {
    throw new Error(
      `dispatch.writeManifest: inflight/${manifest.taskId}${MANIFEST_SUFFIX} already exists; release before re-emitting`,
    );
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return target;
}

/**
 * Read a manifest from disk. Returns `undefined` if the file vanished
 * between the caller seeing it and our read (common race during sweeps).
 */
function readManifest(filePath: string): DispatchManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (isFsErrorCode(err, 'ENOENT')) return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as DispatchManifest;
  } catch {
    return undefined;
  }
}

/**
 * Atomically claim the next eligible manifest from `queue/` matching the
 * requested Worker kind. Implementation:
 *
 *   1. List `queue/*.dispatch.json` sorted by mtime (oldest first — FIFO).
 *   2. For each candidate, parse the manifest. Skip if `workerKind` does
 *      not match the caller's kind and is not `any`. Skip if `noClaimBefore`
 *      is in the future (OQ-7 quota cool-down).
 *   3. Attempt `renameSync(queue/<id>, inflight/<id>)`. If it succeeds,
 *      this caller won the race — return the manifest. If it fails with
 *      `ENOENT`, another Worker beat us; continue to the next candidate.
 *
 * Returns `{ claimed: false }` when the queue is empty (or contains only
 * non-matching / cool-down entries).
 */
export function claimNext(
  boardDir: string,
  workerKind: WorkerKind,
  now: () => Date = () => new Date(),
): ClaimResult {
  ensureBoardDirs(boardDir);
  const queueDir = path.join(boardDir, 'queue');

  const candidates = listManifestCandidates(queueDir);
  const wallNow = now().getTime();
  for (const candidate of candidates) {
    const manifest = readManifest(candidate.fullPath);
    if (!manifest) continue;

    if (manifest.workerKind !== 'any' && manifest.workerKind !== workerKind) {
      continue;
    }

    if (manifest.noClaimBefore) {
      const claimAfter = Date.parse(manifest.noClaimBefore);
      if (!Number.isNaN(claimAfter) && claimAfter > wallNow) {
        continue;
      }
    }

    const inflightPath = manifestPathIn(boardDir, 'inflight', manifest.taskId);
    try {
      renameSync(candidate.fullPath, inflightPath);
    } catch (err) {
      if (isFsErrorCode(err, 'ENOENT')) {
        // Another Worker beat us to this manifest — try the next candidate.
        continue;
      }
      throw err;
    }
    return { claimed: true, manifestPath: inflightPath, manifest };
  }

  return { claimed: false };
}

/**
 * Move a manifest back from `inflight/` to `queue/`. Used when a Worker
 * decides it cannot proceed (e.g. precondition violation) and wants to
 * surrender the claim without writing a verdict.
 *
 * Returns true when the release succeeded, false when no inflight entry
 * existed under that taskId.
 */
export function releaseInflight(boardDir: string, taskId: string): boolean {
  ensureBoardDirs(boardDir);
  const src = manifestPathIn(boardDir, 'inflight', taskId);
  const dst = manifestPathIn(boardDir, 'queue', taskId);
  if (!existsSync(src)) return false;
  // Clear any stale heartbeat state — the next Worker starts fresh.
  const state = path.join(boardDir, 'inflight', `${taskId}${STATE_SUFFIX}`);
  if (existsSync(state)) {
    try {
      rmSync(state);
    } catch {
      /* ignore — state file is advisory */
    }
  }
  renameSync(src, dst);
  return true;
}

/**
 * Read board occupancy without mutating state. Useful for the Conductor's
 * backpressure decision (don't emit new manifests if queue+inflight ≥ cap).
 */
export function peekQueue(boardDir: string): QueueCounts {
  ensureBoardDirs(boardDir);
  return {
    queued: countManifests(path.join(boardDir, 'queue')),
    inflight: countManifests(path.join(boardDir, 'inflight')),
    done: countVerdicts(path.join(boardDir, 'done')),
    failed: countDiagnostics(path.join(boardDir, 'failed')),
  };
}

/**
 * Read every verdict landed in `done/` (success path) and, optionally, the
 * diagnostics in `failed/`. The Conductor uses this on each tick to find
 * newly-completed Workers.
 *
 * Returned verdicts are sorted by `completedAt` (oldest first) so callers
 * can FIFO-fan-out reviewer subagents.
 *
 * `failed` defaults to true so the Conductor's done/+failed/ poll is a
 * single call.
 */
export function collectVerdicts(
  boardDir: string,
  opts: { includeFailed?: boolean } = {},
): DispatchVerdict[] {
  ensureBoardDirs(boardDir);
  const includeFailed = opts.includeFailed ?? true;
  const verdicts: DispatchVerdict[] = [];

  for (const sub of includeFailed ? (['done', 'failed'] as const) : (['done'] as const)) {
    const dir = path.join(boardDir, sub);
    // done/ only holds `.verdict.json` files. failed/ holds both `.verdict.json`
    // (Worker-written failures via writeVerdict) AND `.diagnostic.json` (the
    // supervisor's sweepStaleHeartbeats writes via writeDiagnostic). We must
    // read both suffixes from failed/ so the Conductor sees stale-heartbeat
    // reaps + spawn-rejected paths in the same poll. This mirrors how
    // countDiagnostics and removeVerdict already handle the dual suffix.
    const acceptDiagnostic = sub === 'failed';
    for (const entry of safeReaddir(dir)) {
      const isVerdict = entry.endsWith(VERDICT_SUFFIX);
      const isDiagnostic = acceptDiagnostic && entry.endsWith(DIAGNOSTIC_SUFFIX);
      if (!isVerdict && !isDiagnostic) continue;
      const verdict = readVerdict(path.join(dir, entry));
      if (verdict) verdicts.push(verdict);
    }
  }

  verdicts.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  return verdicts;
}

/** Read one verdict; returns undefined on parse/io error. */
function readVerdict(filePath: string): DispatchVerdict | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as DispatchVerdict;
  } catch {
    return undefined;
  }
}

/**
 * Worker-side: emit a verdict to either `done/` (outcome === 'success' |
 * 'iterate-needed') or `failed/` (everything else). The matching manifest
 * in `inflight/` is removed because the lifecycle has ended.
 *
 * Atomic write: temp + rename in the destination directory.
 *
 * Returns the final verdict path.
 */
export function writeVerdict(boardDir: string, verdict: DispatchVerdict): string {
  ensureBoardDirs(boardDir);
  const targetSubdir =
    verdict.outcome === 'success' || verdict.outcome === 'iterate-needed' ? 'done' : 'failed';
  const verdictPath = path.join(boardDir, targetSubdir, `${verdict.taskId}${VERDICT_SUFFIX}`);
  const tmp = `${verdictPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(verdict, null, 2) + '\n', 'utf-8');
  renameSync(tmp, verdictPath);

  // Clear inflight artifacts — manifest + heartbeat state.
  const inflightManifest = manifestPathIn(boardDir, 'inflight', verdict.taskId);
  if (existsSync(inflightManifest)) {
    try {
      rmSync(inflightManifest);
    } catch {
      /* ignore — verdict landing is the source of truth */
    }
  }
  const inflightState = path.join(boardDir, 'inflight', `${verdict.taskId}${STATE_SUFFIX}`);
  if (existsSync(inflightState)) {
    try {
      rmSync(inflightState);
    } catch {
      /* ignore */
    }
  }
  return verdictPath;
}

/**
 * Worker-side: write/update the heartbeat state file at
 * `inflight/<task-id>.state.json`. Atomic write — partial heartbeats are
 * never visible to the sweeper.
 */
export function writeHeartbeat(boardDir: string, heartbeat: InflightHeartbeat): string {
  ensureBoardDirs(boardDir);
  const target = path.join(boardDir, 'inflight', `${heartbeat.taskId}${STATE_SUFFIX}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(heartbeat, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return target;
}

/**
 * Read the heartbeat for a task (if any). Returns undefined when no state
 * file exists or it can't be parsed.
 */
export function readHeartbeat(boardDir: string, taskId: string): InflightHeartbeat | undefined {
  const target = path.join(boardDir, 'inflight', `${taskId}${STATE_SUFFIX}`);
  if (!existsSync(target)) return undefined;
  try {
    return JSON.parse(readFileSync(target, 'utf-8')) as InflightHeartbeat;
  } catch {
    return undefined;
  }
}

/**
 * Sweep `inflight/` for heartbeats older than `staleMs`. Each stale entry
 * is moved to `failed/` with a `stale-heartbeat` diagnostic; its manifest +
 * state files are deleted from `inflight/`.
 *
 * This is the supervisor-side equivalent of the Anthropic 600s watchdog —
 * but our threshold is 30 min (matches ShellClaudePSpawner.DEFAULT_TIMEOUT_MS
 * per RFC-0041 OQ-3).
 *
 * Returns the taskIds reaped (useful for tests + audit logging).
 */
export function sweepStaleHeartbeats(
  boardDir: string,
  opts: {
    staleMs?: number;
    now?: () => Date;
  } = {},
): SweepResult {
  ensureBoardDirs(boardDir);
  const staleMs = opts.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = now.getTime() - staleMs;
  const reaped: string[] = [];

  const inflightDir = path.join(boardDir, 'inflight');
  for (const entry of safeReaddir(inflightDir)) {
    if (!entry.endsWith(MANIFEST_SUFFIX)) continue;
    const taskId = entry.slice(0, -MANIFEST_SUFFIX.length);
    const manifestPath = path.join(inflightDir, entry);
    const manifest = readManifest(manifestPath);
    if (!manifest) continue;

    // Heartbeat-driven decision: if a state file exists, use its
    // lastHeartbeat. If not, the Worker has not heartbeated yet — fall back
    // to the manifest's dispatchedAt as the start time.
    const heartbeat = readHeartbeat(boardDir, taskId);
    const lastTickMs = heartbeat
      ? Date.parse(heartbeat.lastHeartbeat)
      : Date.parse(manifest.dispatchedAt);
    if (Number.isNaN(lastTickMs) || lastTickMs > cutoff) continue;

    // Reap: write diagnostic, remove inflight artifacts. workerKind is
    // populated only when we have a concrete claimer kind to record —
    // heartbeat first, manifest fallback (only if not 'any').
    const resolvedKind: WorkerKind | undefined = heartbeat?.workerKind
      ? heartbeat.workerKind
      : manifest.workerKind === 'any'
        ? undefined
        : (manifest.workerKind as WorkerKind);
    const diagnostic: DispatchVerdict = {
      schemaVersion: 'v1',
      taskId,
      outcome: 'failed',
      completedAt: now.toISOString(),
      workerId: heartbeat?.workerId ?? 'unknown',
      cause: 'stale-heartbeat',
      notes: `inflight heartbeat ${new Date(lastTickMs).toISOString()} older than ${staleMs}ms`,
    };
    if (resolvedKind !== undefined) diagnostic.workerKind = resolvedKind;
    writeDiagnostic(boardDir, diagnostic);

    // Remove inflight manifest + state file.
    try {
      rmSync(manifestPath);
    } catch {
      /* ignore */
    }
    const statePath = path.join(inflightDir, `${taskId}${STATE_SUFFIX}`);
    if (existsSync(statePath)) {
      try {
        rmSync(statePath);
      } catch {
        /* ignore */
      }
    }
    reaped.push(taskId);
  }

  return { reapedTaskIds: reaped };
}

/**
 * Internal: write a diagnostic JSON to `failed/<taskId>.diagnostic.json`.
 * Atomic temp+rename. Exposed so the supervisor (Phase 2) can also call it
 * for spawn-rejected paths.
 */
function writeDiagnostic(boardDir: string, verdict: DispatchVerdict): string {
  ensureBoardDirs(boardDir);
  const target = path.join(boardDir, 'failed', `${verdict.taskId}${DIAGNOSTIC_SUFFIX}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(verdict, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return target;
}

/**
 * Conductor-side: remove a verdict file from `done/` (or `failed/`) once
 * the Conductor has processed it (reviewer fan-out done, attestation
 * signed, PR opened, etc.). Idempotent — missing files are a no-op.
 */
export function removeVerdict(
  boardDir: string,
  taskId: string,
  subdir: 'done' | 'failed' = 'done',
): void {
  ensureBoardDirs(boardDir);
  // Verdicts and diagnostics use different suffixes; check both.
  for (const suffix of [VERDICT_SUFFIX, DIAGNOSTIC_SUFFIX]) {
    const target = path.join(boardDir, subdir, `${taskId}${suffix}`);
    if (existsSync(target)) {
      try {
        rmSync(target);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ManifestCandidate {
  fullPath: string;
  mtimeMs: number;
}

function listManifestCandidates(dir: string): ManifestCandidate[] {
  const entries: ManifestCandidate[] = [];
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith(MANIFEST_SUFFIX)) continue;
    const fullPath = path.join(dir, file);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      // File vanished between readdir + stat; skip.
      continue;
    }
    entries.push({ fullPath, mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return entries;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (isFsErrorCode(err, 'ENOENT')) return [];
    throw err;
  }
}

function countManifests(dir: string): number {
  let n = 0;
  for (const f of safeReaddir(dir)) {
    if (f.endsWith(MANIFEST_SUFFIX)) n++;
  }
  return n;
}

function countVerdicts(dir: string): number {
  let n = 0;
  for (const f of safeReaddir(dir)) {
    if (f.endsWith(VERDICT_SUFFIX)) n++;
  }
  return n;
}

function countDiagnostics(dir: string): number {
  let n = 0;
  for (const f of safeReaddir(dir)) {
    if (f.endsWith(DIAGNOSTIC_SUFFIX) || f.endsWith(VERDICT_SUFFIX)) n++;
  }
  return n;
}

function isFsErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Best-effort filesystem mtime override — used in tests to age files for
 * the FIFO sort + stale-heartbeat sweeper. Not a public API surface.
 *
 * @internal
 */
export function _setMtimeForTest(filePath: string, mtimeMs: number): void {
  const secs = mtimeMs / 1000;
  utimesSync(filePath, secs, secs);
}
