/**
 * RFC-0035 Phase 9 — `decision-exemplars.yaml` curated store (AISDLC-293).
 *
 * The **curated training corpus** the framework actually consults for
 * Stage C prompt-anchoring. Sourced from `pending-exemplars.yaml` via
 * operator-driven promotion (affirm / reclassify). Rejected pending
 * exemplars stay in `pending-exemplars.yaml` for audit but never land
 * here.
 *
 * ### Why a third file in the calibration chain?
 *
 * The split is:
 *
 *   - **substrate corpus** (`.ai-sdlc/classifier-corpus/<task-type>.yaml`)
 *     — raw, append-only audit log of every classifier call. Owned by
 *     the substrate. Phase 9 doesn't touch this.
 *   - **pending exemplars** (`.ai-sdlc/pending-exemplars.yaml`) — the
 *     operator-review queue. Mirrors substrate entries that need a human
 *     verdict; the operator dispositions each one. Owned by Phase 9.
 *   - **decision exemplars** (`.ai-sdlc/decision-exemplars.yaml`) — the
 *     curated, operator-blessed training corpus. The substrate's Stage C
 *     prompt-builder reads these to anchor future LLM calls (Phase 10+).
 *     Owned by Phase 9.
 *
 * Three files instead of one because each one has a different lifecycle:
 * the substrate corpus is high-volume + append-only; pending exemplars is
 * low-volume + mutable (operator dispositions move records through
 * states); decision exemplars is low-volume + immutable (once promoted,
 * an exemplar is part of the training corpus and shouldn't churn).
 *
 * ### Schema
 *
 * Same per-record shape as `PendingExemplar` minus the disposition fields
 * (those collapse into the promotion act). Plus a `promotedAt` /
 * `promotedBy` pair for audit + a `classification` field that captures
 * the OPERATOR's final answer (LLM's class for affirmed, operator's class
 * for reclassified).
 *
 * @module decisions/decision-exemplars
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

import type { ClassifierTaskType } from '../classifier/substrate/index.js';

import {
  readPendingExemplars,
  setPendingExemplarDisposition,
  type PendingExemplar,
} from './pending-exemplars.js';

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the decision-exemplars file path. Default:
 * `<repoRoot>/.ai-sdlc/decision-exemplars.yaml`. Overridable for tests.
 */
export function resolveDecisionExemplarsPath(repoRoot: string, path?: string): string {
  return path ?? join(repoRoot, '.ai-sdlc', 'decision-exemplars.yaml');
}

// ── Record shape ─────────────────────────────────────────────────────────────

/**
 * One curated exemplar in the training corpus. `polarity` captures whether
 * the LLM was right (positive — silence-promoted) or wrong (negative —
 * operator-overridden). `classification` is the OPERATOR-BLESSED final
 * answer; for positives it equals `originalClassification`; for negatives
 * it equals `operatorOverrideClassification`.
 *
 * `originalClassification` is the LLM's classification at call time; we
 * keep it for diff-style training prompts ("here's the wrong answer +
 * the right answer + why").
 *
 * The promotion provenance (`promotedFromCorpusEntryId`, `promotedAt`,
 * `promotedBy`) makes it possible to trace every curated exemplar back to
 * the substrate audit log + the operator who promoted it.
 */
export interface DecisionExemplar {
  /** UUID — same as the originating PendingExemplar.id. */
  id: string;
  /** ISO-8601 promotion timestamp. */
  promotedAt: string;
  /** Operator identifier who promoted it (email / login). */
  promotedBy?: string;
  /** Substrate corpus entry id this exemplar was promoted from. */
  promotedFromCorpusEntryId: string;
  /** Optional decision id (DEC-NNNN) for back-traceability. */
  decisionId?: string;
  taskType: ClassifierTaskType;
  /** The LLM's original classification (kept for diff-style training). */
  originalClassification: string;
  /** The OPERATOR-BLESSED final classification (correct answer). */
  classification: string;
  /** Polarity in the substrate sense — positive = LLM was right, negative = LLM was wrong. */
  polarity: 'positive' | 'negative';
  /** The substrate's input text the LLM saw — used for prompt-anchoring. */
  inputText: string;
  /** LLM confidence at call time. */
  confidence: number;
  /** LLM rationale snippet. */
  reasoning: string;
  /** Operator's rationale for the promotion (affirm / reclassify). */
  promotionRationale?: string;
}

// ── Atomic write helpers ─────────────────────────────────────────────────────

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isDecisionExemplar(v: unknown): v is DecisionExemplar {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.promotedAt === 'string' &&
    typeof e.promotedFromCorpusEntryId === 'string' &&
    typeof e.taskType === 'string' &&
    typeof e.originalClassification === 'string' &&
    typeof e.classification === 'string' &&
    (e.polarity === 'positive' || e.polarity === 'negative') &&
    typeof e.inputText === 'string' &&
    typeof e.confidence === 'number' &&
    typeof e.reasoning === 'string'
  );
}

export function readDecisionExemplars(repoRoot: string, path?: string): DecisionExemplar[] {
  const file = resolveDecisionExemplarsPath(repoRoot, path);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isDecisionExemplar);
}

function writeDecisionExemplars(
  repoRoot: string,
  entries: DecisionExemplar[],
  path?: string,
): string {
  const file = resolveDecisionExemplarsPath(repoRoot, path);
  ensureParentDir(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, yamlDump(entries, { lineWidth: -1 }), { encoding: 'utf8' });
  renameSync(tmp, file);
  return file;
}

// ── Promotion (pending → decision-exemplars) ─────────────────────────────────

export interface PromoteResult {
  /** True when a new exemplar landed in decision-exemplars.yaml. */
  promoted: boolean;
  reason?:
    | 'pending-not-found'
    | 'pending-not-disposed'
    | 'pending-disposition-rejected'
    | 'already-promoted';
  /** When `promoted: true`, the new DecisionExemplar; otherwise the existing one (if any). */
  exemplar?: DecisionExemplar;
}

/**
 * Build a `DecisionExemplar` from a `PendingExemplar`. Pure / no I/O.
 *
 * - `disposition: 'affirmed'` → final classification is the LLM's
 *   classification (`originalClassification === classification`).
 * - `disposition: 'reclassified'` → final classification is the
 *   operator's `dispositionClassification`.
 * - `disposition: 'pending' | 'rejected'` → NOT promotable; caller should
 *   not invoke this and `promoteAffirmedPendingExemplar` guards against
 *   it.
 */
export function buildDecisionExemplar(opts: {
  pending: PendingExemplar;
  now?: string;
  promotedBy?: string;
  rationale?: string;
}): DecisionExemplar {
  const { pending } = opts;
  const finalClassification =
    pending.disposition === 'reclassified' && pending.dispositionClassification
      ? pending.dispositionClassification
      : pending.classification;

  const exemplar: DecisionExemplar = {
    id: pending.id,
    promotedAt: opts.now ?? new Date().toISOString(),
    promotedFromCorpusEntryId: pending.corpusEntryId,
    taskType: pending.taskType,
    originalClassification: pending.classification,
    classification: finalClassification,
    polarity: pending.polarity,
    inputText: pending.inputText,
    confidence: pending.confidence,
    reasoning: pending.reasoning,
  };

  if (pending.decisionId !== undefined) exemplar.decisionId = pending.decisionId;
  if (opts.promotedBy !== undefined) exemplar.promotedBy = opts.promotedBy;
  const rationale = opts.rationale ?? pending.dispositionRationale;
  if (rationale !== undefined) exemplar.promotionRationale = rationale;
  return exemplar;
}

/**
 * Promote ONE pending exemplar (by id). Promotion requires the pending
 * entry's `disposition` to be `affirmed` or `reclassified`. Returns a
 * structured result describing what happened.
 *
 * Idempotent: if the same id is already in `decision-exemplars.yaml`,
 * returns `{ promoted: false, reason: 'already-promoted' }` without
 * mutating the file.
 */
export function promotePendingExemplar(opts: {
  repoRoot: string;
  exemplarId: string;
  now?: string;
  promotedBy?: string;
  pendingPath?: string;
  decisionExemplarsPath?: string;
}): PromoteResult {
  const pending = readPendingExemplars(opts.repoRoot, opts.pendingPath);
  const entry = pending.find((e) => e.id === opts.exemplarId);
  if (!entry) return { promoted: false, reason: 'pending-not-found' };
  if (entry.disposition === 'pending') {
    return { promoted: false, reason: 'pending-not-disposed' };
  }
  if (entry.disposition === 'rejected') {
    return { promoted: false, reason: 'pending-disposition-rejected' };
  }

  const decisions = readDecisionExemplars(opts.repoRoot, opts.decisionExemplarsPath);
  const dup = decisions.find((d) => d.id === opts.exemplarId);
  if (dup) return { promoted: false, reason: 'already-promoted', exemplar: dup };

  const built = buildDecisionExemplar({
    pending: entry,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.promotedBy !== undefined ? { promotedBy: opts.promotedBy } : {}),
  });
  const next = [...decisions, built];
  writeDecisionExemplars(opts.repoRoot, next, opts.decisionExemplarsPath);
  return { promoted: true, exemplar: built };
}

// ── Batch promotion (digest / aggregator path) ───────────────────────────────

export interface PromoteAllResult {
  /** Number of pending exemplars promoted in this run. */
  promotedCount: number;
  /** Number of pending exemplars skipped because already-promoted. */
  skippedCount: number;
  /** Per-task-type breakdown of promotions. */
  perTaskType: Record<string, number>;
  /** Ids of the exemplars that were promoted. */
  promotedIds: string[];
}

/**
 * Promote every pending exemplar with `disposition: 'affirmed'` or
 * `'reclassified'` to `decision-exemplars.yaml`. Skips pending and rejected
 * dispositions. Idempotent on already-promoted entries.
 *
 * Used by:
 *   - `cli-decisions exemplars promote-all` for batch operator workflow.
 *   - The weekly-digest sweep as the "harvest" half of the loop.
 */
export function promoteAllDisposedPendingExemplars(opts: {
  repoRoot: string;
  now?: string;
  promotedBy?: string;
  pendingPath?: string;
  decisionExemplarsPath?: string;
}): PromoteAllResult {
  const pending = readPendingExemplars(opts.repoRoot, opts.pendingPath);
  const decisions = readDecisionExemplars(opts.repoRoot, opts.decisionExemplarsPath);
  const knownIds = new Set(decisions.map((d) => d.id));
  const perTaskType: Record<string, number> = {};
  const promotedIds: string[] = [];
  let promotedCount = 0;
  let skippedCount = 0;

  const nextDecisions = [...decisions];
  for (const entry of pending) {
    if (entry.disposition !== 'affirmed' && entry.disposition !== 'reclassified') continue;
    if (knownIds.has(entry.id)) {
      skippedCount++;
      continue;
    }
    const built = buildDecisionExemplar({
      pending: entry,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.promotedBy !== undefined ? { promotedBy: opts.promotedBy } : {}),
    });
    nextDecisions.push(built);
    knownIds.add(entry.id);
    promotedCount++;
    perTaskType[entry.taskType] = (perTaskType[entry.taskType] ?? 0) + 1;
    promotedIds.push(entry.id);
  }

  if (promotedCount > 0) {
    writeDecisionExemplars(opts.repoRoot, nextDecisions, opts.decisionExemplarsPath);
  }
  return { promotedCount, skippedCount, perTaskType, promotedIds };
}

// ── Convenience: disposition → promote in one call ───────────────────────────

/**
 * Convenience for the operator CLI: set a disposition + immediately
 * promote when the disposition is `affirmed` or `reclassified`. Caller
 * can pass `autoPromote: false` to defer promotion to the next batch.
 *
 * Returns the disposition result + (when applicable) the promotion
 * result so the CLI can show "affirmed AND promoted" in one breath.
 */
export interface DisposeAndPromoteOpts {
  repoRoot: string;
  exemplarId: string;
  disposition: 'affirmed' | 'reclassified' | 'rejected';
  classification?: string;
  rationale?: string;
  by?: string;
  now?: string;
  autoPromote?: boolean;
  pendingPath?: string;
  decisionExemplarsPath?: string;
}

export interface DisposeAndPromoteResult {
  disposition: ReturnType<typeof setPendingExemplarDisposition>;
  promotion?: PromoteResult;
}

export function disposeAndOptionallyPromote(opts: DisposeAndPromoteOpts): DisposeAndPromoteResult {
  const disposition = setPendingExemplarDisposition({
    repoRoot: opts.repoRoot,
    exemplarId: opts.exemplarId,
    disposition: opts.disposition,
    ...(opts.classification !== undefined ? { classification: opts.classification } : {}),
    ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.pendingPath !== undefined ? { path: opts.pendingPath } : {}),
  });

  if (!disposition.updated) return { disposition };
  if (opts.disposition === 'rejected') return { disposition };
  if (opts.autoPromote === false) return { disposition };

  const promotion = promotePendingExemplar({
    repoRoot: opts.repoRoot,
    exemplarId: opts.exemplarId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.by !== undefined ? { promotedBy: opts.by } : {}),
    ...(opts.pendingPath !== undefined ? { pendingPath: opts.pendingPath } : {}),
    ...(opts.decisionExemplarsPath !== undefined
      ? { decisionExemplarsPath: opts.decisionExemplarsPath }
      : {}),
  });
  return { disposition, promotion };
}
