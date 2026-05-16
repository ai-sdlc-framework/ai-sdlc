/**
 * Estimate-log writer — RFC-0016 Phase 2 (AISDLC-280).
 *
 * Captures every Stage A verdict as an append-only JSONL row at
 * `$ARTIFACTS_DIR/_estimates/log.jsonl`. The writer is the primary
 * Phase 3 measurement-ingest surface — the calibration collector reads
 * this file to compute per-class bias.
 *
 * RFC §8.4 (Q5 resolution) machinery riding on the writer:
 *
 *  - `estimateInputHash` ties every row to the materially-LLM-affecting
 *    inputs (title + description + signals + class). Same-hash rows
 *    aggregate as an ensemble (median bucket + variance signal); a
 *    fresh hash starts a new ensemble.
 *  - `runIndex` is 1, 2, 3, … for repeated runs against the same
 *    hash. The writer scans the existing log for matching hashes on
 *    each call so the index advances deterministically.
 *  - When the hash changes for a `taskId` whose last entry used a
 *    different hash, the writer emits an `EstimateInputChanged` event
 *    BEFORE appending the new row (so the events stream's transition
 *    marker precedes the row that triggered it).
 *
 * RFC-0015 wiring (AC #4):
 *
 *  - Every successful capture emits an `EstimateCaptured` orchestrator
 *    event via the existing `writeEvent()` writer in `orchestrator/events.ts`.
 *  - When the hash transitioned for a known task, an `EstimateInputChanged`
 *    event precedes the captured event.
 *  - Events.jsonl writes are gated by `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`
 *    (per RFC-0015) — when the orchestrator flag is off the events
 *    writes no-op silently, but the log.jsonl write still happens (it
 *    is governed by RFC-0016's own `AI_SDLC_ESTIMATION_CALIBRATION` flag,
 *    checked by the caller).
 *
 * Best-effort writes: an IO failure on the log or events path is
 * surfaced via the optional logger but never rethrown — a transient
 * disk hiccup can't crash a pipeline run.
 *
 * @module estimation/log-writer
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeEvent } from '../orchestrator/events.js';
import type { PipelineLogger } from '../types.js';
import { computeEstimateInputHash } from './hash.js';
import type { Bucket, SignalOutput, StageAConfidence, StageAResult, TaskClass } from './types.js';

// ── Capture record (one JSONL line) ─────────────────────────────────────

/**
 * The on-disk shape of one row in `_estimates/log.jsonl`.
 *
 * Field set is the union of:
 *  - RFC §7.1 capture record fields (`ts`, `predictedBy`, `taskId`,
 *    `class`, `bucket`, `context`)
 *  - RFC §6.3 Stage A/B verdict structure (`stageA`)
 *  - RFC §8.4 ensemble fields (`estimateInputHash`, `runIndex`)
 *  - Acceptance criterion #2: `finalBucket`
 *
 * Stage B fields are intentionally absent — Phase 4 lands them
 * additively (the schema is `additionalProperties: true` on the
 * stageA branch).
 */
export interface EstimateLogRecord {
  ts: string;
  /** Agent identity. RFC §7.1 — model + harness ("claude-opus-4-7", "stage-a-deterministic", …). */
  predictedBy: string;
  taskId: string;
  class: TaskClass;
  /** RFC §5.2 candidate bucket — single bucket or the LOW end of a range. */
  bucket: Bucket;
  /** RFC §5.2 range expression when confidence = medium and signals straddle 2 adjacent buckets. */
  bucketRange?: { low: Bucket; high: Bucket };
  /** AC #2: explicit `finalBucket` field — equals `bucket` in Phase 2 (no Stage B yet). */
  finalBucket: Bucket;
  stageA: {
    signals: SignalOutput[];
    candidateBucket: Bucket;
    candidateRange?: { low: Bucket; high: Bucket };
    confidence: StageAConfidence;
    escalateToStageB: boolean;
    rationale: string;
  };
  /** RFC §8.4 content hash. `sha256:<hex>`. */
  estimateInputHash: string;
  /** RFC §8.4 ensemble run index (1, 2, 3 for repeated runs against the same hash). */
  runIndex: number;
  /** RFC §7.1 — free-text scope description. */
  context?: string;
  /** RFC §7.1 — optional structured scope factors the agent considered. */
  scopeFactors?: string[];
  /** RFC §7.1 — class assignment provenance (cached / source: heuristic|frontmatter|default|llm). */
  classSource: 'frontmatter' | 'heuristic' | 'default' | 'llm';
  /** Whether the class assignment was served from the §6.5 cache (Phase 2 AC #3). */
  classCached: boolean;
}

// ── Capture options ─────────────────────────────────────────────────────

export interface CaptureEstimateOpts {
  stageA: StageAResult;
  /** Task title — input to `estimateInputHash`. */
  taskTitle: string;
  /** Task description — input to `estimateInputHash`. Empty string when absent. */
  taskDescription: string;
  /**
   * Class assignment provenance — `'llm'` is reserved for Phase 4+
   * when the assigner switches from the heuristic. Defaults to
   * `stageA.classSource` (mapped onto the wider enum) when omitted.
   */
  classSource?: EstimateLogRecord['classSource'];
  /** Whether the class assignment was served from the cache. Defaults to `false`. */
  classCached?: boolean;
  /** Agent identity. Defaults to `'stage-a-deterministic'` (Phase 1/2 has no LLM). */
  predictedBy?: string;
  /** RFC §7.1 free-text scope description. */
  context?: string;
  /** RFC §7.1 structured scope factors. */
  scopeFactors?: string[];
  /**
   * Artifacts directory. Falls back to env then `<cwd>/artifacts`.
   * Production callers usually leave this undefined.
   */
  artifactsDir?: string;
  /**
   * Override `Date.now()` for the row's `ts` field + the events
   * writer's clock. Tests inject a frozen clock.
   */
  now?: () => Date;
  /** Optional logger — surfaces best-effort write failures. */
  logger?: PipelineLogger;
}

export interface CaptureEstimateResult {
  /** The record that was appended to the log. */
  record: EstimateLogRecord;
  /** Path of the log file the row was appended to (for debugging / tests). */
  logPath: string;
  /** Whether the orchestrator events writer also fired (gated by RFC-0015 flag). */
  eventEmitted: boolean;
  /** Whether an `EstimateInputChanged` event fired (true when the hash transitioned). */
  inputChangedEmitted: boolean;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Append one row to `_estimates/log.jsonl` and emit the corresponding
 * events.jsonl entries. Returns the appended record + paths so the
 * caller can surface them to operators / tests.
 *
 * Per AC #1, this function is the single capture point — every agent
 * estimate flows through here. Callers (the CLI today, the orchestrator
 * tomorrow) MUST NOT format their own log rows.
 */
export function captureEstimate(opts: CaptureEstimateOpts): CaptureEstimateResult {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const logPath = estimateLogPath(artifactsDir);
  const now = opts.now ?? ((): Date => new Date());
  const ts = now().toISOString();

  const estimateInputHash = computeEstimateInputHash({
    taskTitle: opts.taskTitle,
    taskDescription: opts.taskDescription,
    stageASignals: opts.stageA.signals,
    taskClass: opts.stageA.taskClass,
  });

  // Existing log scan — for runIndex + hash-transition detection.
  const existing = readExistingLog(logPath);
  const runIndex = countRunsForHash(existing, opts.stageA.taskId, estimateInputHash) + 1;
  const previousHash = mostRecentHashForTask(existing, opts.stageA.taskId);
  const hashTransitioned = previousHash !== undefined && previousHash !== estimateInputHash;

  const record: EstimateLogRecord = {
    ts,
    predictedBy: opts.predictedBy ?? 'stage-a-deterministic',
    taskId: opts.stageA.taskId,
    class: opts.stageA.taskClass,
    bucket: opts.stageA.candidateBucket,
    ...(opts.stageA.candidateRange ? { bucketRange: opts.stageA.candidateRange } : {}),
    finalBucket: opts.stageA.candidateBucket,
    stageA: {
      signals: opts.stageA.signals,
      candidateBucket: opts.stageA.candidateBucket,
      ...(opts.stageA.candidateRange ? { candidateRange: opts.stageA.candidateRange } : {}),
      confidence: opts.stageA.confidence,
      escalateToStageB: opts.stageA.escalateToStageB,
      rationale: opts.stageA.rationale,
    },
    estimateInputHash,
    runIndex,
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    ...(opts.scopeFactors !== undefined ? { scopeFactors: opts.scopeFactors } : {}),
    classSource: opts.classSource ?? (opts.stageA.classSource as EstimateLogRecord['classSource']),
    classCached: opts.classCached ?? false,
  };

  // Append to log.jsonl FIRST so the row is durable before any events
  // fire — that way an events-write failure doesn't leave a missing
  // log row, and the row's presence is the source of truth for Phase 3
  // calibration. Events are observability; the log is canon.
  appendLogRecord(logPath, record, opts.logger);

  // Hash-transition event MUST precede the captured event so a
  // chronological reader sees: ... change → captured → ... .
  let inputChangedEmitted = false;
  if (hashTransitioned) {
    inputChangedEmitted = writeEvent(
      {
        ts,
        type: 'EstimateInputChanged',
        taskId: opts.stageA.taskId,
        oldHash: previousHash,
        newHash: estimateInputHash,
      },
      { artifactsDir, now: opts.now, logger: opts.logger },
    );
  }

  const eventEmitted = writeEvent(
    {
      ts,
      type: 'EstimateCaptured',
      taskId: opts.stageA.taskId,
      bucket: record.bucket,
      finalBucket: record.finalBucket,
      class: record.class,
      estimateInputHash,
      runIndex,
      confidence: record.stageA.confidence,
      escalateToStageB: record.stageA.escalateToStageB,
    },
    { artifactsDir, now: opts.now, logger: opts.logger },
  );

  return { record, logPath, eventEmitted, inputChangedEmitted };
}

// ── Path helpers ────────────────────────────────────────────────────────

/**
 * Resolve the absolute path of the log file. Exported so cli-status +
 * tests can derive the same path without duplicating the convention.
 *
 * RFC §10 schema entry: `$ARTIFACTS_DIR/_estimates/log.jsonl`.
 */
export function estimateLogPath(artifactsDir: string): string {
  return join(artifactsDir, '_estimates', 'log.jsonl');
}

// ── Reader (cli-status / tests) ─────────────────────────────────────────

export interface ReadLogOpts {
  artifactsDir?: string;
  /** Optional taskId filter (case-insensitive). */
  taskId?: string;
  /** Cap on number of rows returned (newest-last). 0 = all. */
  limit?: number;
}

/**
 * Read every row from `_estimates/log.jsonl`. Malformed JSON lines are
 * skipped silently (best-effort, matches the events reader). Returns
 * the parsed rows in append (chronological) order.
 */
export function readEstimateLog(opts: ReadLogOpts = {}): EstimateLogRecord[] {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const path = estimateLogPath(artifactsDir);
  const rows = readExistingLog(path);
  let filtered = rows;
  if (opts.taskId) {
    const id = opts.taskId.toLowerCase();
    filtered = rows.filter((r) => r.taskId.toLowerCase() === id);
  }
  if (opts.limit && opts.limit > 0 && filtered.length > opts.limit) {
    return filtered.slice(filtered.length - opts.limit);
  }
  return filtered;
}

// ── Internals ───────────────────────────────────────────────────────────

function resolveArtifactsDir(explicit: string | undefined): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

function appendLogRecord(path: string, record: EstimateLogRecord, logger?: PipelineLogger): void {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(`[estimate-log] write failed (path=${path}): ${reason}`);
  }
}

function readExistingLog(path: string): EstimateLogRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: EstimateLogRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as EstimateLogRecord;
      if (parsed && typeof parsed === 'object' && typeof parsed.taskId === 'string') {
        out.push(parsed);
      }
    } catch {
      // skip malformed lines silently
    }
  }
  return out;
}

function countRunsForHash(
  rows: readonly EstimateLogRecord[],
  taskId: string,
  hash: string,
): number {
  let n = 0;
  for (const r of rows) {
    if (r.taskId === taskId && r.estimateInputHash === hash) n += 1;
  }
  return n;
}

function mostRecentHashForTask(
  rows: readonly EstimateLogRecord[],
  taskId: string,
): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.taskId === taskId) return rows[i]?.estimateInputHash;
  }
  return undefined;
}
