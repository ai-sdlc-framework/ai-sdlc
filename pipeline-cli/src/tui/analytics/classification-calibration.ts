/**
 * RFC-0025 §13 OQ-1 calibration loop — Phase 2 (AISDLC-303).
 *
 * Composes the confidence-bucketed classifier (`quality-classifier.ts`)
 * with the shared AISDLC-321 classifier substrate's polarity model:
 *
 *   - **Operator overrides feed back as negative exemplars** (AC-6 in the
 *     substrate; AC-4 in this task) — when an operator changes the
 *     classification within the override window, the corresponding corpus
 *     entry flips `polarity: pending → negative`, capturing both what the
 *     classifier said + what the operator picked + an optional reason.
 *   - **Silence as positive exemplar** (AC-7 in the substrate; AC-4 in
 *     this task) — entries that age past the override window without an
 *     operator override flip `polarity: pending → positive`, marking the
 *     classifier's choice as confirmed.
 *
 * The substrate's existing storage primitives (`appendCorpusEntry`,
 * `readCorpus`, `setCorpusEntryPolarity`) and the same per-org override-
 * window resolver are reused verbatim — per the task brief: "uses the
 * shared classifier substrate from AISDLC-321 (no new classifier
 * infrastructure)."
 *
 * **Task type slot**: the substrate's `ClassifierTaskType` enum is closed
 * (one of five: `capture-triage` / `capture-severity` / `pr-comment-is-
 * capture` / `dor-answer-is-new-concern` / `decision-recommendation`).
 * Adding a new task type would require changes to allowed-classification
 * tables + prompt templates + tests; that's out of scope for Phase 2.
 * Instead, the calibration loop writes to a parallel corpus directory
 * (`.ai-sdlc/classifier-corpus-quality/`) using the same per-task-type
 * file convention so the substrate's helpers can read/write our entries
 * by passing a corpusDir override. The slot we reuse is `capture-triage`
 * — semantically closest to "did the classifier triage correctly?" — but
 * the corpus file segregation prevents cross-contamination with the
 * RFC-0024 capture-triage exemplars.
 *
 * The slot choice is recorded explicitly in `QUALITY_CLASSIFICATION_TASK_TYPE`
 * so future calibration tooling (`cli-classifier corpus aggregate`) can
 * filter our corpus directory out of the per-task-type aggregator and run
 * a separate per-failure-mode-fingerprint accuracy report.
 *
 * @module tui/analytics/classification-calibration
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  appendCorpusEntry,
  readCorpus,
  resolveOverrideWindowHours,
  setCorpusEntryPolarity,
  type CalibrationCorpusEntry,
  type ClassifierTaskType,
} from '../../classifier/substrate/index.js';
import type {
  ClassificationResult,
  ConfidenceBucket,
  FailureClass,
  FailureSignal,
  FrameworkSubclass,
} from './quality-classifier.js';

// ── Corpus segregation ───────────────────────────────────────────────────

/**
 * Substrate task-type slot the quality-monitoring calibration loop reuses
 * for its corpus entries. See module docstring for the rationale — TL;DR:
 * the substrate's enum is closed; we pick the semantically closest slot
 * (`capture-triage`) but segregate the on-disk corpus to avoid mixing
 * exemplars across surfaces.
 */
export const QUALITY_CLASSIFICATION_TASK_TYPE: ClassifierTaskType = 'capture-triage';

/**
 * Corpus directory name (relative to `<repoRoot>/.ai-sdlc/`) for the
 * quality-classifier calibration loop. Distinct from the substrate's
 * `classifier-corpus/` directory so the RFC-0024 capture-triage exemplars
 * don't get mixed with our framework-failure-mode exemplars.
 */
export const QUALITY_CLASSIFICATION_CORPUS_DIR_NAME = 'classifier-corpus-quality';

/** Resolve the absolute corpus directory used by the calibration loop. */
export function resolveQualityCalibrationCorpusDir(repoRoot: string): string {
  return join(repoRoot, '.ai-sdlc', QUALITY_CLASSIFICATION_CORPUS_DIR_NAME);
}

// ── Append (record a classifier output for later calibration) ────────────

export interface RecordClassificationOpts {
  repoRoot: string;
  /** The classification result returned by `classifyFailure()`. */
  classification: ClassificationResult;
  /** The original failure signal — surfaces in `input.text` for review. */
  signal: FailureSignal;
  /** Optional task identifier — surfaces in `input.context.taskId`. */
  taskId?: string;
  /** Optional worker identifier — surfaces in `input.context.workerId`. */
  workerId?: string;
  /** ISO-8601 timestamp; defaults to `new Date().toISOString()`. */
  now?: string;
  /** Corpus directory override (tests). */
  corpusDir?: string;
}

export interface RecordClassificationResult {
  /** The substrate-compatible entry id; pass to `recordClassificationOverride()` later. */
  corpusEntryId: string;
  /** The persisted entry — exposed for caller-side audit. */
  entry: CalibrationCorpusEntry;
  /** True when the entry was actually written. False on `'unclassified'` per OQ-1. */
  recorded: boolean;
}

/**
 * Append a classification corpus entry per OQ-1 calibration semantics:
 *
 * - `'auto-classify'` and `'ambiguous'` buckets record an entry with
 *   `polarity: 'pending'`. The operator-override path can flip it to
 *   `negative`; the silence-sweeper promotes it to `positive`.
 * - `'unclassified'` bucket does NOT record an entry by default. The
 *   task brief specifies "no operator-facing artifact" — and the
 *   calibration corpus IS an operator-facing artifact (operators review
 *   it during walkthroughs). Logging the breakdown via the classifier's
 *   `ctx.logger.info` channel is the substitute. Callers who explicitly
 *   want to capture unclassified entries for post-mortem analysis pass
 *   `recordEvenWhenUnclassified: true`.
 */
export function recordClassification(
  opts: RecordClassificationOpts & { recordEvenWhenUnclassified?: boolean },
): RecordClassificationResult {
  const now = opts.now ?? new Date().toISOString();
  const classification = opts.classification;

  // Honor the OQ-1 "no operator-facing artifact" constraint for unclassified.
  if (classification.bucket === 'unclassified' && !opts.recordEvenWhenUnclassified) {
    return {
      corpusEntryId: '',
      entry: {} as CalibrationCorpusEntry,
      recorded: false,
    };
  }

  const id = randomUUID();
  const entry: CalibrationCorpusEntry = {
    id,
    timestamp: now,
    taskType: QUALITY_CLASSIFICATION_TASK_TYPE,
    input: {
      text: (opts.signal.stderr ?? '').slice(0, 2000),
      context: {
        // Surface failure-mode taxonomy fingerprint in the corpus entry's
        // context so the aggregator can group exemplars by class/subclass
        // when retuning the heuristic weights.
        failureClass: classification.class,
        subclass: classification.subclass ?? null,
        exitCode: opts.signal.exitCode ?? null,
        source: opts.signal.source ?? null,
        bucket: classification.bucket,
        effectiveThresholds: classification.effectiveThresholds,
        taskId: opts.taskId ?? null,
        workerId: opts.workerId ?? null,
      },
    },
    // The substrate's model field is a free-form identifier — we name the
    // heuristic version so a future LLM-based classifier swap can be
    // detected at corpus-aggregator time.
    model: 'rfc-0025-heuristic-v2',
    classification: encodeClassification(classification.class, classification.subclass),
    confidence: classification.confidence,
    reasoning: classification.rationale,
    threshold: classification.effectiveThresholds.autoClassify,
    metBehindThreshold: classification.bucket === 'auto-classify',
    polarity: 'pending',
  };

  const corpusDir = opts.corpusDir ?? resolveQualityCalibrationCorpusDir(opts.repoRoot);
  appendCorpusEntry(opts.repoRoot, entry, corpusDir);
  return { corpusEntryId: id, entry, recorded: true };
}

// ── Operator override (negative exemplar — AC-4) ─────────────────────────

export interface ClassificationOverrideOpts {
  repoRoot: string;
  corpusEntryId: string;
  /** The class the operator picked instead. */
  newClass: FailureClass;
  /** Optional subclass when the operator picked `framework-misbehaved`. */
  newSubclass?: FrameworkSubclass;
  /** Operator-supplied reason — surfaces in the corpus entry. */
  reason?: string;
  /** ISO-8601 override timestamp; defaults to `new Date().toISOString()`. */
  now?: string;
  /** Corpus directory override (tests). */
  corpusDir?: string;
}

export type ClassificationOverrideReason =
  | 'no-corpus-entry-id'
  | 'entry-not-found'
  | 'window-expired'
  | 'already-resolved';

export interface ClassificationOverrideResult {
  flipped: boolean;
  reason?: ClassificationOverrideReason;
  /** The updated entry, when `flipped: true`. */
  entry?: CalibrationCorpusEntry;
}

/**
 * Record an operator override (AC-4 / AC-6-equivalent). Composes with the
 * substrate's `recordOperatorOverride` semantics:
 *
 * - When the entry exists, is `pending`, and is still inside the
 *   override window → flip polarity to `negative`, attach the operator's
 *   chosen classification + reason.
 * - When the entry is `already-resolved` (positive or negative) → no-op
 *   with `reason: 'already-resolved'`.
 * - When the entry is outside the override window → no-op with
 *   `reason: 'window-expired'` (the silence-sweeper has already promoted
 *   it to `positive`; the corpus is sealed for this entry).
 * - When the entry id is missing or unknown → no-op.
 *
 * We do NOT call the substrate's `recordOperatorOverride()` directly
 * because that helper reads `capture-config.yaml` for the override
 * window and our `corpusDir` is segregated. Instead we reuse the same
 * window resolver + the same `setCorpusEntryPolarity()` primitive so the
 * semantics + polarity vocabulary stay identical.
 */
export function recordClassificationOverride(
  opts: ClassificationOverrideOpts,
): ClassificationOverrideResult {
  if (!opts.corpusEntryId) {
    return { flipped: false, reason: 'no-corpus-entry-id' };
  }

  const corpusDir = opts.corpusDir ?? resolveQualityCalibrationCorpusDir(opts.repoRoot);
  const entries = readCorpus(opts.repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
  const entry = entries.find((e) => e.id === opts.corpusEntryId);
  if (!entry) {
    return { flipped: false, reason: 'entry-not-found' };
  }
  if (entry.polarity !== 'pending') {
    return { flipped: false, reason: 'already-resolved' };
  }

  const windowHours = resolveOverrideWindowHours(opts.repoRoot);
  const now = opts.now ?? new Date().toISOString();
  if (isOutsideWindow(entry.timestamp, now, windowHours)) {
    return { flipped: false, reason: 'window-expired' };
  }

  const updated = setCorpusEntryPolarity(
    opts.repoRoot,
    QUALITY_CLASSIFICATION_TASK_TYPE,
    opts.corpusEntryId,
    {
      polarity: 'negative',
      operatorOverrideClassification: encodeClassification(opts.newClass, opts.newSubclass),
      operatorOverrideReason: opts.reason,
      operatorOverrideTimestamp: now,
    },
    corpusDir,
  );
  if (!updated) {
    return { flipped: false, reason: 'entry-not-found' };
  }
  return { flipped: true, entry: updated };
}

// ── Silence sweeper (positive exemplar — AC-4) ───────────────────────────

export interface ResolveClassificationSilenceOpts {
  repoRoot: string;
  /** ISO-8601 reference time; defaults to `new Date().toISOString()`. */
  now?: string;
  /** Corpus directory override (tests). */
  corpusDir?: string;
}

export interface ResolveClassificationSilenceResult {
  /** Number of pending entries flipped to `positive`. */
  promotedCount: number;
  /** The override window in hours that was applied. */
  windowHours: number;
}

/**
 * Promote `pending` quality-classification entries older than the
 * override window to `positive` (AC-4 silence-as-positive). Mirrors the
 * substrate's `resolveSilenceAsPositive()` semantics scoped to the
 * quality-classification corpus directory.
 *
 * Best-effort: a write failure for one entry doesn't block subsequent
 * entries. Returns the promoted-count + the applied window.
 */
export function resolveClassificationSilence(
  opts: ResolveClassificationSilenceOpts,
): ResolveClassificationSilenceResult {
  const windowHours = resolveOverrideWindowHours(opts.repoRoot);
  const now = opts.now ?? new Date().toISOString();
  const corpusDir = opts.corpusDir ?? resolveQualityCalibrationCorpusDir(opts.repoRoot);

  const entries = readCorpus(opts.repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
  const toPromote = entries.filter(
    (e) => e.polarity === 'pending' && isOutsideWindow(e.timestamp, now, windowHours),
  );

  let promotedCount = 0;
  for (const e of toPromote) {
    const updated = setCorpusEntryPolarity(
      opts.repoRoot,
      QUALITY_CLASSIFICATION_TASK_TYPE,
      e.id,
      { polarity: 'positive', operatorOverrideTimestamp: now },
      corpusDir,
    );
    if (updated) promotedCount++;
  }

  return { promotedCount, windowHours };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Encode a `(class, subclass?)` pair into a single classifier-corpus
 * `classification` string. The substrate stores this as a free-form
 * string (per its type definition); we use `<class>` for non-framework
 * results and `<class>:<subclass>` for framework-misbehaved.
 */
function encodeClassification(cls: FailureClass, subclass?: FrameworkSubclass): string {
  if (cls === 'framework-misbehaved' && subclass) return `${cls}:${subclass}`;
  return cls;
}

/**
 * Mirrors the substrate's private `isOutsideWindow` — kept inline so we
 * don't depend on the substrate's internals.
 */
function isOutsideWindow(entryIso: string, nowIso: string, windowHours: number): boolean {
  const entryMs = Date.parse(entryIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(entryMs) || !Number.isFinite(nowMs)) return false;
  const elapsedHours = (nowMs - entryMs) / 3_600_000;
  return elapsedHours >= windowHours;
}

// ── Re-exports for downstream convenience ────────────────────────────────

export type { ConfidenceBucket };
