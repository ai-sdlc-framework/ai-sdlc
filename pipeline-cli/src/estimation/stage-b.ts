/**
 * Stage B — LLM tie-breaker — RFC-0016 §6 + Phase 4 (AISDLC-282).
 *
 * Stage B is the LAST-RESORT tier. It runs only when Stage A escalates
 * (confidence = low, i.e. signals split across non-adjacent buckets per
 * §5.2) OR when same-hash variance ≥ 2 buckets (§8.4 Q5 rule). In all
 * other cases Stage B is forbidden.
 *
 * ## Escalation gate (AC #1)
 *
 * `shouldEscalateToStageB()` enforces the two escalation conditions:
 *  - Stage A returned `escalateToStageB: true` (confidence = low).
 *  - Caller passes `variance` ≥ 2 (ensemble variance computed by the
 *    log-writer across same-hash rows).
 *
 * ## Prompt shape (AC #2 — §6.1)
 *
 * The full Stage A signal table is serialised into the prompt so the LLM
 * has deterministic context. It does NOT re-guess wall-clock from
 * intuition; it adjudicates the disagreement between already-computed
 * signals (§6.2).
 *
 * ## Verdict shape (AC #3)
 *
 * Stage B returns one bucket or a 2-bucket range + a justification
 * string ≤2 sentences. The verdict is stored in `log.jsonl` alongside
 * the Stage A signals (§6.3 schema) and sets the `finalBucket` column
 * for calibration consumers.
 *
 * ## Q5 ensemble aggregation (AC #5)
 *
 * When Stage B is called multiple times for the same `estimateInputHash`
 * (deliberate sampling passes), `aggregateStageBEnsemble()` takes the
 * batch and returns the median bucket + ensemble variance. Stage B
 * verdicts aggregate just like Stage A verdicts — no overwrite, only
 * medians.
 *
 * ## Telemetry (AC #6)
 *
 * `computeStageBCallRate()` reads `_estimates/log.jsonl` and returns
 * the fraction of estimate rows that have `stageB.invoked = true`. The
 * caller (the CLI / orchestrator) surfaces this as an operational
 * metric; the function itself is pure over log records (no I/O).
 *
 * @module estimation/stage-b
 */

import { createHash } from 'node:crypto';

import type { Bucket, SignalOutput, StageAResult, TaskClass } from './types.js';
import { BUCKET_INDEX, BUCKETS } from './types.js';
import type { EstimateLogRecord } from './log-writer.js';
import type { PipelineLogger } from '../types.js';

// ── Escalation gate ────────────────────────────────────────────────────────

/**
 * Escalation inputs. Both the Stage A result and the ensemble variance
 * for the same `estimateInputHash` are required — either condition alone
 * is sufficient to trigger Stage B.
 */
export interface EscalationInput {
  stageA: Pick<StageAResult, 'escalateToStageB'>;
  /**
   * Ensemble variance across same-hash log rows:
   * `max(finalBucketIndex) − min(finalBucketIndex)`.
   * 0 for a single-run estimate (no prior rows for this hash).
   */
  variance: number;
}

/**
 * Returns `true` when Stage B SHOULD be invoked for this estimate.
 *
 * Two escalation conditions (RFC §5.2 + §8.4):
 *  1. Stage A confidence = low (signals split across non-adjacent
 *     buckets or ≥3 buckets) → `stageA.escalateToStageB === true`.
 *  2. Same-hash ensemble variance ≥ 2 buckets.
 *
 * When neither condition holds, Stage B is forbidden (§6.4).
 */
export function shouldEscalateToStageB(input: EscalationInput): boolean {
  return input.stageA.escalateToStageB || input.variance >= 2;
}

// ── Prompt builder (§6.1) ─────────────────────────────────────────────────

/**
 * Build the Stage B prompt per §6.1. The full Stage A signal table is
 * serialised as a structured block so the LLM has deterministic context
 * rather than guessing from intuition.
 *
 * Output format mirrors the RFC's worked example (§6.1 prompt shape).
 */
export function buildStageBPrompt(opts: {
  taskTitle: string;
  taskDescription: string;
  taskClass: TaskClass;
  stageAResult: StageAResult;
}): string {
  const { taskTitle, taskDescription, taskClass, stageAResult } = opts;

  const signalLines = stageAResult.signals
    .map((s) => {
      const resultDesc = formatSignalResult(s);
      return `  ${s.id}. ${s.name}: ${resultDesc}`;
    })
    .join('\n');

  const disagreement = buildDisagreementDescription(stageAResult);

  return [
    `TASK: ${taskTitle}`,
    taskDescription.trim() ? `TASK DESCRIPTION: ${taskDescription.trim()}` : '',
    `TASK CLASS: ${taskClass}`,
    '',
    'DETERMINISTIC SIGNALS (Stage A):',
    signalLines,
    '',
    `STAGE A VERDICT: ${stageAResult.candidateBucket}${stageAResult.candidateRange ? `-${stageAResult.candidateRange.high}` : ''} (confidence: ${stageAResult.confidence})`,
    '',
    `DISAGREEMENT: ${disagreement}`,
    '',
    'TASK: judge whether the disagreement resolves to a single bucket or 2-bucket range.',
    'Output ONE bucket (XS/S/M/L/XL) or a 2-bucket range (e.g. S-M).',
    'Justify in ≤2 sentences.',
    'Format: BUCKET: <bucket-or-range>',
    'JUSTIFICATION: <≤2 sentences>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatSignalResult(signal: SignalOutput): string {
  const { result } = signal;
  switch (result.kind) {
    case 'bucket':
      return `→ bucket ${result.bucket}`;
    case 'range':
      return `→ range ${result.low}-${result.high}`;
    case 'bump':
      return `→ ${result.delta > 0 ? `+${result.delta}` : result.delta} bucket bump`;
    case 'unknown':
      return `→ unknown (${result.reason})`;
  }
}

function buildDisagreementDescription(stageAResult: StageAResult): string {
  const votingSignals = stageAResult.signals.filter(
    (s) => s.result.kind === 'bucket' || s.result.kind === 'range',
  );
  if (votingSignals.length === 0) {
    return 'no signals resolved — cold-start, class-default fallback unavailable';
  }

  const bucketLabels = votingSignals.map((s) => {
    if (s.result.kind === 'bucket') return `${s.name} → ${s.result.bucket}`;
    if (s.result.kind === 'range') return `${s.name} → ${s.result.low}-${s.result.high}`;
    return '';
  });

  if (stageAResult.candidateRange) {
    return `signals split between ${stageAResult.candidateRange.low} and ${stageAResult.candidateRange.high}: ${bucketLabels.join('; ')}`;
  }
  return `signals disagree: ${bucketLabels.join('; ')}`;
}

// ── Response parser ────────────────────────────────────────────────────────

/**
 * Stage B verdict as returned by `parseStageBResponse` and stored in the
 * log record's `stageB` field.
 */
export interface StageBVerdict {
  /** Single bucket or the LOW end of a 2-bucket range. */
  bucket: Bucket;
  /** High end when Stage B returned a range. */
  bucketHigh?: Bucket;
  /** Justification string (≤2 sentences per §6.3). */
  justification: string;
  /** Full prompt hash for audit. `sha256:<hex>`. */
  promptHash: string;
}

/**
 * Parse the raw LLM response into a `StageBVerdict`.
 *
 * Expected shape (per the prompt template):
 * ```
 * BUCKET: S-M
 * JUSTIFICATION: ...
 * ```
 *
 * Tolerant parsing: accepts lowercase, optional leading/trailing
 * whitespace, and various separator styles. Returns `null` when the
 * response cannot be parsed (the caller should treat this as a Stage B
 * failure and fall back to Stage A's verdict).
 */
export function parseStageBResponse(rawResponse: string, promptHash: string): StageBVerdict | null {
  const lines = rawResponse.split(/\r?\n/).map((l) => l.trim());

  let bucket: Bucket | null = null;
  let bucketHigh: Bucket | undefined;
  let justification = '';

  for (const line of lines) {
    const bucketMatch = line.match(/^(?:BUCKET|bucket)\s*:\s*([A-Za-z-]+)/);
    if (bucketMatch) {
      const parsed = parseBucketOrRange(bucketMatch[1]!.trim());
      if (parsed) {
        bucket = parsed.low;
        bucketHigh = parsed.high !== parsed.low ? parsed.high : undefined;
      }
      continue;
    }

    const justMatch = line.match(/^(?:JUSTIFICATION|justification)\s*:\s*(.+)/i);
    if (justMatch) {
      justification = justMatch[1]!.trim();
    }
  }

  if (bucket === null) return null;

  return {
    bucket,
    ...(bucketHigh !== undefined ? { bucketHigh } : {}),
    justification: justification || '(no justification provided)',
    promptHash,
  };
}

function parseBucketOrRange(raw: string): { low: Bucket; high: Bucket } | null {
  // Accept "S-M", "S", "XL", "xs-s" etc.
  const upper = raw.toUpperCase();
  const rangeMatch = upper.match(/^(XS|S|M|L|XL)-(XS|S|M|L|XL)$/);
  if (rangeMatch) {
    const low = rangeMatch[1] as Bucket;
    const high = rangeMatch[2] as Bucket;
    // Ensure low ≤ high by index order.
    const lowIdx = BUCKET_INDEX[low];
    const highIdx = BUCKET_INDEX[high];
    if (lowIdx <= highIdx) return { low, high };
    return { low: high, high: low };
  }
  const singleMatch = upper.match(/^(XS|S|M|L|XL)$/);
  if (singleMatch) {
    const b = singleMatch[1] as Bucket;
    return { low: b, high: b };
  }
  return null;
}

// ── Stage B invocation result ──────────────────────────────────────────────

/**
 * Result of a single Stage B invocation (one LLM call or one mock call
 * via the injected `invoker`). The caller decides whether to store this
 * as a log entry or aggregate it with prior same-hash calls.
 */
export interface StageBResult {
  /** Whether Stage B was invoked. Always `true` from this function. */
  invoked: true;
  verdict: StageBVerdict;
  /** The prompt that was sent to the LLM (for audit). */
  prompt: string;
  /** `sha256:<hex>` of the prompt string. */
  promptHash: string;
}

/**
 * Stage B was NOT invoked (escalation conditions not met or Stage B
 * explicitly disabled). `finalBucket` remains Stage A's `candidateBucket`.
 */
export interface StageBSkipped {
  invoked: false;
  skipReason: string;
}

// ── LLM invoker injection ──────────────────────────────────────────────────

/**
 * Async callable that sends a prompt to the LLM and returns the raw text
 * response. Production code injects the Anthropic SDK client; tests inject
 * a synchronous mock via a Promise wrapper.
 *
 * The invoker MUST NOT be called outside `runStageB` — all rate-limiting,
 * escalation gating, and response parsing happen in this module.
 */
export type StageBInvoker = (prompt: string) => Promise<string>;

// ── Public API ─────────────────────────────────────────────────────────────

export interface RunStageBOpts {
  taskTitle: string;
  taskDescription: string;
  stageAResult: StageAResult;
  /**
   * Ensemble variance across prior same-hash log rows. Computed by the
   * caller from `computeEnsembleVarianceForHash()` (or 0 for first run).
   */
  variance: number;
  /**
   * LLM invoker. Tests inject a mock; production code injects the real
   * Anthropic SDK. When omitted, Stage B is skipped with a
   * `'no LLM invoker provided'` reason — useful for dry-run / preview
   * flows where Stage B is available but we don't want to bill.
   */
  invoker?: StageBInvoker;
  /** Optional logger for best-effort diagnostics. */
  logger?: PipelineLogger;
}

/**
 * Run Stage B for one estimate. Enforces the escalation gate, builds the
 * prompt per §6.1, invokes the LLM, and parses the response.
 *
 * Returns `StageBResult` when Stage B ran successfully, or `StageBSkipped`
 * when the escalation conditions were not met or the invoker is missing.
 *
 * This function is async because real LLM calls are async. Tests keep
 * invokers synchronous (via `async () => <string>`) so the await is
 * zero-cost in test context.
 */
export async function runStageB(opts: RunStageBOpts): Promise<StageBResult | StageBSkipped> {
  // AC #1 — escalation gate
  if (!shouldEscalateToStageB({ stageA: opts.stageAResult, variance: opts.variance })) {
    return {
      invoked: false,
      skipReason: `escalation conditions not met (confidence=${opts.stageAResult.confidence}, variance=${opts.variance})`,
    };
  }

  if (!opts.invoker) {
    return {
      invoked: false,
      skipReason: 'no LLM invoker provided (dry-run / preview mode)',
    };
  }

  // AC #2 — build prompt with full Stage A signal table per §6.1
  const prompt = buildStageBPrompt({
    taskTitle: opts.taskTitle,
    taskDescription: opts.taskDescription,
    taskClass: opts.stageAResult.taskClass,
    stageAResult: opts.stageAResult,
  });

  const promptHash = computePromptHash(prompt);

  let rawResponse: string;
  try {
    rawResponse = await opts.invoker(prompt);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger?.warn(`[stage-b] LLM invoker failed: ${reason}`);
    return {
      invoked: false,
      skipReason: `LLM invoker threw: ${reason}`,
    };
  }

  // AC #3 — parse response into bucket or 2-bucket range + justification
  const verdict = parseStageBResponse(rawResponse, promptHash);
  if (!verdict) {
    opts.logger?.warn(`[stage-b] could not parse LLM response: ${rawResponse.slice(0, 200)}`);
    return {
      invoked: false,
      skipReason: `LLM response unparseable: ${rawResponse.slice(0, 100)}`,
    };
  }

  return {
    invoked: true,
    verdict,
    prompt,
    promptHash,
  };
}

// ── Q5 ensemble aggregation ────────────────────────────────────────────────

/**
 * Aggregate multiple Stage B verdicts for the same `estimateInputHash`
 * into a single consensus bucket (AC #5 — Q5 ensemble).
 *
 * Algorithm:
 *  - Collect all bucket indices from each verdict (both `bucket` and
 *    `bucketHigh` when a range was returned).
 *  - Median index → consensus bucket.
 *  - Variance = maxIdx − minIdx across the batch.
 *
 * Returns `null` when the input array is empty.
 */
export interface StageBEnsembleResult {
  /** Median Stage B bucket across the ensemble. */
  medianBucket: Bucket;
  /** Ensemble variance (maxBucketIdx − minBucketIdx). 0 for n=1. */
  ensembleVariance: number;
  /** Number of Stage B calls in the ensemble. */
  n: number;
}

export function aggregateStageBEnsemble(
  verdicts: readonly StageBVerdict[],
): StageBEnsembleResult | null {
  if (verdicts.length === 0) return null;

  // Collect all bucket indices (both ends of any ranges).
  const allIndices: number[] = [];
  for (const v of verdicts) {
    allIndices.push(BUCKET_INDEX[v.bucket]);
    if (v.bucketHigh !== undefined) {
      allIndices.push(BUCKET_INDEX[v.bucketHigh]);
    }
  }

  const sorted = [...allIndices].sort((a, b) => a - b);
  const medianIdx = sorted[Math.floor(sorted.length / 2)]!;
  const medianBucket = BUCKETS[medianIdx]!;
  const ensembleVariance = sorted[sorted.length - 1]! - sorted[0]!;

  return { medianBucket, ensembleVariance, n: verdicts.length };
}

// ── Ensemble variance helper ───────────────────────────────────────────────

/**
 * Compute ensemble variance across all log rows sharing the given
 * `estimateInputHash`. Pure function over the provided log rows (AC #4).
 *
 * Variance = max(finalBucketIndex) − min(finalBucketIndex) across all
 * same-hash rows. Returns 0 when there is 0 or 1 matching row.
 */
export function computeEnsembleVarianceForHash(
  logRows: readonly EstimateLogRecord[],
  estimateInputHash: string,
): number {
  const sameHash = logRows.filter((r) => r.estimateInputHash === estimateInputHash);
  if (sameHash.length <= 1) return 0;
  const indices = sameHash.map((r) => BUCKET_INDEX[r.finalBucket]);
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  return max - min;
}

// ── Stage B call rate telemetry (AC #6) ───────────────────────────────────

/**
 * Compute the Stage B call rate across a set of log records.
 *
 * Per AC #6, Stage B call rate SHOULD stay below 30% of total estimates.
 * This function returns the rate (0.0–1.0) so the CLI / orchestrator can
 * surface it as an operational metric.
 *
 * Pure function over `EstimateLogRecord[]` — no I/O.
 *
 * Returns `null` when there are no records (undefined rate, not 0%).
 */
export function computeStageBCallRate(records: readonly EstimateLogRecord[]): number | null {
  if (records.length === 0) return null;
  const stageBCount = records.filter((r) => r.stageB?.invoked === true).length;
  return stageBCount / records.length;
}

/** Threshold above which Stage B call rate is considered excessive (AC #6). */
export const STAGE_B_CALL_RATE_THRESHOLD = 0.3 as const;

// ── Internals ─────────────────────────────────────────────────────────────

function computePromptHash(prompt: string): string {
  return `sha256:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`;
}
