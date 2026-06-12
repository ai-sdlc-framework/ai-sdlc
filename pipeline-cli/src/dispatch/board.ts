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
  DEFAULT_ITERATION_BUDGET,
  type ClaimResult,
  type DispatchManifest,
  type DispatchVerdict,
  type InflightHeartbeat,
  type QueueCounts,
  type ResumeSignal,
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
/**
 * RFC-0041 Phase 1.5 (AISDLC-377.2) — filename suffix for Conductor-written
 * resume signals. Co-located with the still-inflight manifest under
 * `inflight/<task-id>.resume.json` so the active Worker (or supervisor)
 * picks it up on the next poll without touching the manifest itself.
 */
const RESUME_SIGNAL_SUFFIX = '.resume.json';

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
  // Phase 1.5 (AISDLC-377.2): a release surrenders the inflight slot — any
  // pending resume signal must go with it. The Conductor would not have
  // written a resume signal against a manifest it intended to release, but
  // defense-in-depth.
  const resume = path.join(boardDir, 'inflight', `${taskId}${RESUME_SIGNAL_SUFFIX}`);
  if (existsSync(resume)) {
    try {
      rmSync(resume);
    } catch {
      /* ignore */
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
 * 'iterate-needed') or `failed/` (everything else).
 *
 * Inflight cleanup semantics:
 *
 *   - `outcome === 'iterate-needed'` (Phase 1.5 / RFC-0041 OQ-4): the
 *     lifecycle is NOT ending — the Conductor will write a resume signal
 *     next to the still-inflight manifest and the same Worker will
 *     continue against it. The inflight manifest + heartbeat are
 *     PRESERVED. Any pre-existing resume signal (from a prior iteration
 *     of this same cycle) IS cleared so the Worker's next-poll resume
 *     check doesn't see a stale signal.
 *   - Every other outcome: the lifecycle has ended. Inflight manifest +
 *     heartbeat + any lingering resume signal are all cleared.
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

  const isIteratePending = verdict.outcome === 'iterate-needed';

  // For iterate-needed, the Worker is holding the slot across the iteration
  // — leave inflight artifacts in place. For every other outcome the
  // lifecycle has ended; clear them.
  if (!isIteratePending) {
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
  } else if (typeof verdict.iterationsAttempted === 'number') {
    // Phase 1.5 (AISDLC-377.2) — MAJOR #1 close-out (iteration-2 review). When
    // a Worker writes an iterate-needed verdict, the manifest is the canonical
    // record the Conductor's `probeIterationBudget` reads from. If we leave
    // `manifest.iterationsAttempted` untouched, the budget gate stays mute:
    // verdict reports attempts=1 but the manifest still says 0, so the gate
    // would let the Conductor keep writing resume signals past the cap.
    //
    // Atomically rewrite the inflight manifest's iterationsAttempted to
    // match the verdict (the Worker's authoritative burn count). Temp + same-
    // dir rename so the Conductor never sees a partial parse.
    const inflightManifestPath = manifestPathIn(boardDir, 'inflight', verdict.taskId);
    const manifest = readManifest(inflightManifestPath);
    if (manifest) {
      manifest.iterationsAttempted = verdict.iterationsAttempted;
      const tmpM = `${inflightManifestPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpM, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      renameSync(tmpM, inflightManifestPath);
    }
  }
  // Always clear any lingering resume signal — it was specific to the
  // previous iteration cycle, and we don't want the Worker's next-poll
  // resume check to see a stale signal. The Conductor will write a fresh
  // one if (and only if) it decides to trigger another iteration.
  const inflightResume = path.join(
    boardDir,
    'inflight',
    `${verdict.taskId}${RESUME_SIGNAL_SUFFIX}`,
  );
  if (existsSync(inflightResume)) {
    try {
      rmSync(inflightResume);
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
    // Phase 1.5 (AISDLC-377.2): clear any pending resume signal too — the
    // Worker that would have consumed it is presumed dead.
    const resumePath = path.join(inflightDir, `${taskId}${RESUME_SIGNAL_SUFFIX}`);
    if (existsSync(resumePath)) {
      try {
        rmSync(resumePath);
      } catch {
        /* ignore */
      }
    }
    reaped.push(taskId);
  }

  return { reapedTaskIds: reaped };
}

/**
 * Write a diagnostic JSON to `failed/<taskId>.diagnostic.json`. Atomic
 * temp+rename. Used by `sweepStaleHeartbeats` for stale-heartbeat reaps, by
 * the supervisor (Phase 2) for spawn-rejected paths, and — Phase 1.5 — by
 * the Conductor's done-pickup loop when an `iterate-needed` verdict lands at
 * `iterationsAttempted == iterationBudget` (the iteration-exhausted
 * diagnostic).
 *
 * Co-clears the inflight manifest + heartbeat so the lifecycle artifacts
 * don't leak (mirrors `writeVerdict`'s cleanup contract). This matters for
 * the iteration-exhausted path: the Conductor calls this AFTER consuming
 * the iterate-needed verdict from `done/`, and the manifest may still be
 * sitting in `inflight/` (the Worker left it there while it held the slot
 * across the iteration). On budget exhaustion the slot must be released.
 */
export function writeDiagnostic(boardDir: string, verdict: DispatchVerdict): string {
  ensureBoardDirs(boardDir);
  const target = path.join(boardDir, 'failed', `${verdict.taskId}${DIAGNOSTIC_SUFFIX}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(verdict, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);

  // Clear any lingering inflight artifacts (manifest + heartbeat + resume
  // signal). The Conductor's iteration-exhausted path is the canonical
  // caller that needs this: the Worker left the manifest in inflight/ across
  // the iteration window, so on budget exhaustion we must release the slot
  // explicitly. The stale-heartbeat sweep removes inflight artifacts
  // explicitly via the sweeper's own rmSync calls; calling this codepath a
  // second time after that is a harmless no-op (the files are already gone).
  const inflightManifest = manifestPathIn(boardDir, 'inflight', verdict.taskId);
  if (existsSync(inflightManifest)) {
    try {
      rmSync(inflightManifest);
    } catch {
      /* ignore — diagnostic landing is the source of truth */
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
  const inflightResume = path.join(
    boardDir,
    'inflight',
    `${verdict.taskId}${RESUME_SIGNAL_SUFFIX}`,
  );
  if (existsSync(inflightResume)) {
    try {
      rmSync(inflightResume);
    } catch {
      /* ignore */
    }
  }
  return target;
}

/**
 * AISDLC-493 — Conductor-side: patch timing fields onto an existing verdict
 * in `done/`. Used by the reconcile sub-tick to stamp `reviewerStartedAt`,
 * `reviewerCompletedAt`, `signedAt`, and `prOpenedAt` onto the verdict that
 * the Worker originally wrote (which has none of those fields, because they
 * only become known during the Conductor's reconcile pass).
 *
 * Atomic write (temp + rename in same dir). No-op when the file doesn't exist.
 * Returns true when the patch landed; false when the file was absent or
 * unreadable (caller may log but should not fail the reconcile for this).
 */
export function patchDoneVerdict(
  boardDir: string,
  taskId: string,
  patch: Partial<
    Pick<DispatchVerdict, 'reviewerStartedAt' | 'reviewerCompletedAt' | 'signedAt' | 'prOpenedAt'>
  >,
): boolean {
  ensureBoardDirs(boardDir);
  const verdictPath = path.join(boardDir, 'done', `${taskId}${VERDICT_SUFFIX}`);
  if (!existsSync(verdictPath)) return false;
  const existing = readVerdict(verdictPath);
  if (!existing) return false;
  const patched: DispatchVerdict = { ...existing, ...patch };
  const tmp = `${verdictPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(patched, null, 2) + '\n', 'utf-8');
    renameSync(tmp, verdictPath);
    return true;
  } catch {
    try {
      rmSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
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
// Phase 1.5 (AISDLC-377.2) — resume signal + iteration budget
// ---------------------------------------------------------------------------

/**
 * Conductor-side (RFC-0041 OQ-4): write a resume signal next to a still-
 * inflight manifest. The active Worker (in-session-agent) or its supervisor-
 * spawned successor (claude-p-shell) detects the signal on its next poll and
 * resumes its prior conversation with `feedback` prepended.
 *
 * Refuses (throws) when:
 *   - The manifest is NOT in `inflight/` (the Worker has either not claimed
 *     it yet or has already moved it to done/failed; iteration is not safe
 *     in either case — the Conductor should re-emit a fresh manifest if it
 *     wants to retry).
 *   - The iteration budget is already exhausted
 *     (`manifest.iterationsAttempted ?? 0 >= manifest.iterationBudget ?? DEFAULT_ITERATION_BUDGET`).
 *     The caller should write an iteration-exhausted diagnostic instead
 *     (`writeIterationExhaustedDiagnostic` below).
 *
 * Atomic write (temp + rename). Returns the final signal path. Idempotent on
 * the file itself — if an earlier resume signal exists, it is overwritten
 * (the Conductor's done-pickup loop is the only writer, so concurrent writes
 * are not a concern).
 */
export function writeResumeSignal(
  boardDir: string,
  signal: ResumeSignal,
  opts: { iterationBudget?: number; iterationsAttempted?: number } = {},
): string {
  ensureBoardDirs(boardDir);
  const inflightManifestPath = manifestPathIn(boardDir, 'inflight', signal.taskId);
  if (!existsSync(inflightManifestPath)) {
    throw new Error(
      `dispatch.writeResumeSignal: no inflight manifest for ${signal.taskId} — Worker must own an active claim to receive a resume`,
    );
  }
  const manifest = readManifest(inflightManifestPath);
  // Caller may override the manifest's declared budget/attempts when probing
  // (e.g. CLI flags). Fall back to the manifest's own fields, then the
  // package default. The check uses `>=` so the very call that lands the
  // first 'iterate-needed' (priorIteration=1, budget=2) PASSES (1<2 → resume
  // signal allowed → second attempt → iterationsAttempted=2 → on the next
  // iterate-needed THIS check refuses because 2>=2).
  const attempts = opts.iterationsAttempted ?? manifest?.iterationsAttempted ?? 0;
  const budget = opts.iterationBudget ?? manifest?.iterationBudget ?? DEFAULT_ITERATION_BUDGET;
  if (attempts >= budget) {
    throw new Error(
      `dispatch.writeResumeSignal: iteration budget exhausted for ${signal.taskId} (attempts=${attempts}, budget=${budget})`,
    );
  }

  const target = path.join(boardDir, 'inflight', `${signal.taskId}${RESUME_SIGNAL_SUFFIX}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(signal, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return target;
}

/**
 * Worker-side (RFC-0041 OQ-4): read the resume signal co-located with the
 * Worker's still-inflight manifest. Returns `undefined` when no signal
 * exists (the normal case — the Worker only resumes when one was written).
 */
export function readResumeSignal(boardDir: string, taskId: string): ResumeSignal | undefined {
  const target = path.join(boardDir, 'inflight', `${taskId}${RESUME_SIGNAL_SUFFIX}`);
  if (!existsSync(target)) return undefined;
  try {
    return JSON.parse(readFileSync(target, 'utf-8')) as ResumeSignal;
  } catch {
    return undefined;
  }
}

/**
 * Worker-side (RFC-0041 OQ-4): list every pending resume signal in
 * `inflight/`. Returns `[{ taskId, signalPath }]` for each
 * `<task-id>.resume.json` file present. The Worker's poll loop MUST scan
 * this list BEFORE falling back to env-var lookup
 * (`AI_SDLC_DISPATCH_RESUME_TASK_ID`) — env vars are lost on Worker session
 * restart, but the filesystem-durable signal survives. Without the scan, a
 * restart between Conductor's resume-write and Worker's next tick would
 * silently strand the inflight slot until the supervisor's stale-heartbeat
 * sweep reaps it (~30 min later) — the entire iteration burns timeout
 * latency instead of progressing.
 *
 * Returns an empty array when the board is unset up or no signals exist.
 * Caller is responsible for matching signal taskIds against manifest
 * workerKind compatibility before consuming.
 */
export function listResumeSignals(boardDir: string): { taskId: string; signalPath: string }[] {
  const inflightDir = path.join(boardDir, 'inflight');
  const out: { taskId: string; signalPath: string }[] = [];
  for (const entry of safeReaddir(inflightDir)) {
    if (!entry.endsWith(RESUME_SIGNAL_SUFFIX)) continue;
    const taskId = entry.slice(0, -RESUME_SIGNAL_SUFFIX.length);
    out.push({ taskId, signalPath: path.join(inflightDir, entry) });
  }
  return out;
}

/**
 * Worker-side (RFC-0041 OQ-4): consume the resume signal after the Worker
 * has detected it and begun the resume Agent call. Idempotent on missing
 * files. The Worker MUST call this before invoking `writeVerdict` for the
 * resumed attempt — otherwise the signal would persist and trigger a
 * spurious second resume on the next Worker poll.
 */
export function removeResumeSignal(boardDir: string, taskId: string): void {
  const target = path.join(boardDir, 'inflight', `${taskId}${RESUME_SIGNAL_SUFFIX}`);
  if (existsSync(target)) {
    try {
      rmSync(target);
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}

/**
 * Conductor-side helper: read the iteration budget for a task by inspecting
 * its inflight manifest. Returns
 * `{ attempts, budget, exhausted, manifest }` where:
 *
 *   - `attempts` = `manifest.iterationsAttempted ?? 0`
 *   - `budget` = `manifest.iterationBudget ?? DEFAULT_ITERATION_BUDGET`
 *   - `exhausted` = `attempts >= budget` (i.e. NO more resumes allowed)
 *   - `manifest` = the parsed manifest (or undefined when missing)
 *
 * When the manifest is missing OR the iteration fields are absent (v1.0
 * manifests pre-Phase 1.5), the defaults apply. This is the canonical
 * decision surface for the Conductor's done-pickup loop:
 *
 *   const probe = probeIterationBudget(board, taskId);
 *   if (probe.exhausted) {
 *     writeIterationExhaustedDiagnostic(board, ...);
 *   } else {
 *     writeResumeSignal(board, ...);
 *   }
 */
export function probeIterationBudget(
  boardDir: string,
  taskId: string,
): {
  attempts: number;
  budget: number;
  exhausted: boolean;
  manifest: DispatchManifest | undefined;
} {
  const inflightManifestPath = manifestPathIn(boardDir, 'inflight', taskId);
  const manifest = existsSync(inflightManifestPath)
    ? readManifest(inflightManifestPath)
    : undefined;
  const attempts = manifest?.iterationsAttempted ?? 0;
  const budget = manifest?.iterationBudget ?? DEFAULT_ITERATION_BUDGET;
  return { attempts, budget, exhausted: attempts >= budget, manifest };
}

/**
 * Conductor-side: write an iteration-budget-exhausted diagnostic to
 * `failed/`. Called when an `iterate-needed` verdict lands at
 * `iterationsAttempted == iterationBudget` (no more resumes allowed).
 *
 * The diagnostic carries `outcome: iteration-exhausted` + `cause:
 * iteration-budget-exhausted` so the operator-facing escalation surface (TUI
 * + events.jsonl) can render it distinctly from generic failures.
 *
 * Atomic write (delegates to `writeDiagnostic`). The inflight artifacts
 * (manifest, heartbeat, resume signal) are cleared as a side effect — the
 * lifecycle has ended.
 */
export function writeIterationExhaustedDiagnostic(
  boardDir: string,
  args: {
    taskId: string;
    iterationsAttempted: number;
    iterationBudget: number;
    workerId?: string;
    workerKind?: WorkerKind;
    notes?: string;
    completedAt?: string;
  },
): string {
  const diagnostic: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId: args.taskId,
    outcome: 'iteration-exhausted',
    completedAt: args.completedAt ?? new Date().toISOString(),
    workerId: args.workerId ?? 'conductor',
    cause: 'iteration-budget-exhausted',
    iterationsAttempted: args.iterationsAttempted,
    notes:
      args.notes ??
      `iteration budget exhausted (attempts=${args.iterationsAttempted}, budget=${args.iterationBudget}); Conductor refused to trigger further resume per RFC-0041 OQ-4 cap`,
  };
  if (args.workerKind) diagnostic.workerKind = args.workerKind;
  return writeDiagnostic(boardDir, diagnostic);
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
