/**
 * RFC-0035 Phase 9 — `pending-exemplars.yaml` writer + reader (AISDLC-293).
 *
 * Phase 9 closes the override-driven calibration loop sketched in §9.1
 * Auto-exemplar generation. The flow is:
 *
 *   1. Stage C auto-applies a recommendation for a reversible decision
 *      (per Phase 5 / OQ-3). The substrate writes a `pending` corpus entry
 *      and starts the 24h override window.
 *   2. **Operator override during the window** → substrate flips the
 *      corpus entry's polarity to `negative` (via
 *      `recordOperatorOverride()`). Phase 9 mirrors this into
 *      `<repoRoot>/.ai-sdlc/pending-exemplars.yaml` as a **negative
 *      candidate** (AC#1).
 *   3. **Silence past the window** → substrate sweeper flips the corpus
 *      entry to `positive` (via `resolveSilenceAsPositive()`). Phase 9
 *      mirrors this into `pending-exemplars.yaml` as a **positive
 *      candidate** (AC#2).
 *   4. Operator reviews `pending-exemplars.yaml` (via the weekly digest +
 *      `cli-decisions exemplars list`) and either **affirms** (promote to
 *      `decision-exemplars.yaml`), **reclassifies** (promote with operator
 *      override), or **rejects** (drop with rationale; itself a
 *      calibration signal per RFC-0031 pattern).
 *
 * ### Why a separate file from the substrate corpus?
 *
 * The substrate corpus (`<repoRoot>/.ai-sdlc/classifier-corpus/<task-type>.yaml`)
 * is the **raw, append-only audit log** of every classifier call. It
 * captures EVERY classification + override / silence outcome. The substrate
 * file is per-task-type, optimised for the substrate's polarity-flip flow,
 * and grows unboundedly (one entry per classifier call).
 *
 * `pending-exemplars.yaml` is the **operator-review queue** — a curated
 * subset of the substrate corpus that is interesting enough to surface
 * for explicit review. Items either get promoted to `decision-exemplars.yaml`
 * (the **curated training corpus** the framework actually uses for prompt
 * anchoring) or rejected with rationale. This is the same shape as
 * RFC-0031's calibration-driven proposal pattern (`pending-revisions.yaml`
 * → operator review → `did-revisions.yaml`).
 *
 * Separating the two files lets the substrate stay append-only without the
 * operator having to scroll past thousands of raw classifier calls to find
 * the override events that matter.
 *
 * ### Promotion criteria (when does a substrate entry become a candidate?)
 *
 * - **Negative candidates** — every operator override is interesting (AC#1).
 *   The override IS the calibration signal; we don't filter.
 * - **Positive candidates** — only entries that were within the override
 *   window AND ultimately silence-promoted (i.e. the framework's auto-apply
 *   was correct). Silently-correct decisions are the bulk of the corpus and
 *   surfacing all of them is noise; we instead require operator opt-in via
 *   `cli-decisions exemplars sweep --include-positives` (positive sweep is
 *   on-demand, negative mirror is automatic). This keeps the operator's
 *   review queue lean while preserving the full positive corpus for
 *   periodic batch-promotion (AC#2).
 *
 * ### File schema
 *
 * `<repoRoot>/.ai-sdlc/pending-exemplars.yaml` — YAML list-of-records.
 * Each record is a `PendingExemplar` (see below). Atomic writes via
 * rename-after-write; reader is lenient (corrupt-file → `[]` + warn).
 *
 * @module decisions/pending-exemplars
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

import type { CalibrationCorpusEntry, ClassifierTaskType } from '../classifier/substrate/index.js';

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the pending-exemplars file path. Default:
 * `<repoRoot>/.ai-sdlc/pending-exemplars.yaml`. Overridable via the `path`
 * opt — tests use this.
 */
export function resolvePendingExemplarsPath(repoRoot: string, path?: string): string {
  return path ?? join(repoRoot, '.ai-sdlc', 'pending-exemplars.yaml');
}

// ── Pending exemplar record ──────────────────────────────────────────────────

/**
 * One entry in the operator-review queue. Phase 9 §9.1.
 *
 * `polarity` mirrors the substrate corpus value at the time the entry was
 * promoted to a candidate:
 *   - `negative` → operator overrode the LLM's classification within the
 *     window. The operator's chosen classification is in
 *     `operatorOverrideClassification`. The LLM's wrong answer is in
 *     `classification`.
 *   - `positive` → silence past the override window confirmed the LLM's
 *     classification. `operatorOverrideClassification` is absent.
 *
 * `disposition` tracks the operator's review outcome:
 *   - `pending` → not yet reviewed (the file landed here from the substrate
 *     mirror; awaits the operator).
 *   - `affirmed` → operator confirmed; will be promoted to
 *     `decision-exemplars.yaml` on the next aggregate cycle.
 *   - `reclassified` → operator picked a DIFFERENT classification than
 *     either the LLM OR the original override; `dispositionClassification`
 *     holds the new value. Promoted as a negative-exemplar-with-correction.
 *   - `rejected` → operator decided this is NOT a useful calibration
 *     signal (noise, duplicate, edge case the framework can't learn from);
 *     stays in pending-exemplars.yaml with `disposition: rejected` for
 *     audit trail, not promoted.
 *
 * `decisionId` ties the entry back to the originating Decision record so
 * the operator can review the full context (Stage A/B/C breakdown, options
 * list, rationale).
 */
export interface PendingExemplar {
  /** UUID; same as the substrate corpus entry id. */
  id: string;
  /** ISO-8601 timestamp the pending exemplar was created (mirror time). */
  createdAt: string;
  /** Substrate corpus entry id this is mirrored from. */
  corpusEntryId: string;
  /** Task type — copied from the substrate entry. */
  taskType: ClassifierTaskType;
  /** Decision id (DEC-NNNN) the substrate entry was generated for. */
  decisionId?: string;
  /** The LLM's original classification. */
  classification: string;
  /** Self-reported confidence at LLM-call time. */
  confidence: number;
  /** The LLM's rationale snippet (truncated for display). */
  reasoning: string;
  /** The substrate's input text the LLM saw. */
  inputText: string;
  /** The corpus polarity at mirror time — drives the candidate's semantics. */
  polarity: 'positive' | 'negative';
  /** Operator-chosen classification (negative polarity only). */
  operatorOverrideClassification?: string;
  /** Operator-supplied reason for the override (negative polarity only). */
  operatorOverrideReason?: string;
  /** ISO-8601 timestamp of the substrate's polarity flip. */
  resolvedAt?: string;
  /** Operator-review disposition. Default `pending`. */
  disposition: 'pending' | 'affirmed' | 'reclassified' | 'rejected';
  /** When `disposition: 'reclassified'`, the operator's final classification. */
  dispositionClassification?: string;
  /** Free-form operator rationale for affirm/reclassify/reject. */
  dispositionRationale?: string;
  /** ISO-8601 timestamp the operator made the disposition. */
  dispositionAt?: string;
  /** Operator identifier (email / login) for the disposition. */
  dispositionBy?: string;
}

// ── Atomic write helpers ─────────────────────────────────────────────────────

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isPendingExemplar(v: unknown): v is PendingExemplar {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (
    typeof e.id !== 'string' ||
    typeof e.createdAt !== 'string' ||
    typeof e.corpusEntryId !== 'string' ||
    typeof e.taskType !== 'string' ||
    typeof e.classification !== 'string' ||
    typeof e.confidence !== 'number' ||
    typeof e.reasoning !== 'string' ||
    typeof e.inputText !== 'string'
  ) {
    return false;
  }
  if (e.polarity !== 'positive' && e.polarity !== 'negative') return false;
  if (
    e.disposition !== 'pending' &&
    e.disposition !== 'affirmed' &&
    e.disposition !== 'reclassified' &&
    e.disposition !== 'rejected'
  ) {
    return false;
  }
  return true;
}

/**
 * Read every pending exemplar from `<repoRoot>/.ai-sdlc/pending-exemplars.yaml`.
 * Returns `[]` when the file doesn't exist OR can't be parsed (lenient: a
 * corrupted file shouldn't crash the calibration loop — operator inspects
 * the file manually if `readPendingExemplars()` returns surprising
 * results).
 */
export function readPendingExemplars(repoRoot: string, path?: string): PendingExemplar[] {
  const file = resolvePendingExemplarsPath(repoRoot, path);
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
  return parsed.filter(isPendingExemplar);
}

/**
 * Atomic write — rename-after-write. POSIX-atomic on the same filesystem.
 * Caller passes the full list (no append API — Phase 9's writes are small
 * and rare relative to the substrate corpus, so a full rewrite is fine).
 */
function writePendingExemplars(
  repoRoot: string,
  entries: PendingExemplar[],
  path?: string,
): string {
  const file = resolvePendingExemplarsPath(repoRoot, path);
  ensureParentDir(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, yamlDump(entries, { lineWidth: -1 }), { encoding: 'utf8' });
  renameSync(tmp, file);
  return file;
}

// ── Mirroring helpers (substrate corpus → pending-exemplars.yaml) ────────────

/**
 * Build a `PendingExemplar` from a substrate `CalibrationCorpusEntry`.
 * Pure / no I/O — the caller composes this with `appendPendingExemplar()`.
 *
 * `decisionId` is an optional override the caller may pass when the
 * substrate entry was written by Stage C (the decision-id is on the
 * stage-c-completed event, not on the corpus entry itself).
 */
export function buildPendingExemplar(opts: {
  entry: CalibrationCorpusEntry;
  decisionId?: string;
  now?: string;
}): PendingExemplar {
  const { entry } = opts;
  const polarity: 'positive' | 'negative' = entry.polarity === 'negative' ? 'negative' : 'positive';

  const pending: PendingExemplar = {
    id: entry.id,
    createdAt: opts.now ?? new Date().toISOString(),
    corpusEntryId: entry.id,
    taskType: entry.taskType,
    classification: entry.classification,
    confidence: entry.confidence,
    reasoning: entry.reasoning,
    inputText: entry.input.text,
    polarity,
    disposition: 'pending',
  };

  if (opts.decisionId !== undefined) pending.decisionId = opts.decisionId;
  if (entry.operatorOverrideClassification !== undefined) {
    pending.operatorOverrideClassification = entry.operatorOverrideClassification;
  }
  if (entry.operatorOverrideReason !== undefined) {
    pending.operatorOverrideReason = entry.operatorOverrideReason;
  }
  if (entry.operatorOverrideTimestamp !== undefined) {
    pending.resolvedAt = entry.operatorOverrideTimestamp;
  }

  return pending;
}

export interface AppendPendingExemplarResult {
  /** True when a new entry was added. False when the corpus-entry-id was already mirrored. */
  appended: boolean;
  /** The entry that's now in the file (existing or newly appended). */
  entry: PendingExemplar;
}

/**
 * Append a `PendingExemplar` to `pending-exemplars.yaml`. **Idempotent** by
 * `corpusEntryId` — if an entry with the same `corpusEntryId` already
 * exists, no append happens and the existing record is returned (this
 * prevents double-mirror when an override-event is replayed or when the
 * sweeper runs multiple times).
 */
export function appendPendingExemplar(
  repoRoot: string,
  exemplar: PendingExemplar,
  path?: string,
): AppendPendingExemplarResult {
  const existing = readPendingExemplars(repoRoot, path);
  const dup = existing.find((e) => e.corpusEntryId === exemplar.corpusEntryId);
  if (dup) return { appended: false, entry: dup };
  const next = [...existing, exemplar];
  writePendingExemplars(repoRoot, next, path);
  return { appended: true, entry: exemplar };
}

/**
 * Convenience wrapper: build + append in one call. Returns `null` when
 * the substrate entry's polarity isn't a candidate yet (still `pending`
 * in the corpus). This keeps callers from accidentally mirroring entries
 * whose override-window outcome hasn't resolved.
 */
export function mirrorSubstrateEntry(opts: {
  repoRoot: string;
  entry: CalibrationCorpusEntry;
  decisionId?: string;
  now?: string;
  path?: string;
}): AppendPendingExemplarResult | null {
  if (opts.entry.polarity === 'pending') return null;
  const exemplar = buildPendingExemplar({
    entry: opts.entry,
    ...(opts.decisionId !== undefined ? { decisionId: opts.decisionId } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return appendPendingExemplar(opts.repoRoot, exemplar, opts.path);
}

// ── Disposition (operator review) ────────────────────────────────────────────

export type PendingDisposition = 'affirmed' | 'reclassified' | 'rejected';

export interface SetDispositionOpts {
  repoRoot: string;
  /** The id of the pending-exemplar to update. */
  exemplarId: string;
  disposition: PendingDisposition;
  /** Required when `disposition: 'reclassified'`. */
  classification?: string;
  /** Optional operator rationale. */
  rationale?: string;
  /** Operator identifier (email / login). */
  by?: string;
  /** ISO-8601 disposition timestamp. Default: `new Date().toISOString()`. */
  now?: string;
  /** File path override (tests). */
  path?: string;
}

export interface SetDispositionResult {
  /** True when an entry was updated. False when no-op (id not found / already in this disposition). */
  updated: boolean;
  reason?: 'not-found' | 'already-disposed' | 'reclassify-needs-classification';
  entry?: PendingExemplar;
}

/**
 * Record an operator disposition (affirm / reclassify / reject) on a
 * pending exemplar. Mutates the file in-place via atomic rewrite.
 *
 * **Reclassify** requires `classification` (the operator's new
 * classification); we refuse the call when it's missing rather than
 * silently dropping the disposition (calibration data with no answer
 * is worse than no data).
 *
 * **Re-disposition** is allowed when the new disposition differs from
 * the old one (operator changed their mind after thinking longer). Same
 * disposition → no-op (idempotent; lets the CLI re-run safely).
 */
export function setPendingExemplarDisposition(opts: SetDispositionOpts): SetDispositionResult {
  if (opts.disposition === 'reclassified' && !opts.classification) {
    return { updated: false, reason: 'reclassify-needs-classification' };
  }
  const entries = readPendingExemplars(opts.repoRoot, opts.path);
  const idx = entries.findIndex((e) => e.id === opts.exemplarId);
  if (idx === -1) return { updated: false, reason: 'not-found' };
  const existing = entries[idx];

  // Idempotent: same disposition + same classification → no-op (but we
  // still treat it as "updated: false" so the CLI can show "no change").
  if (
    existing.disposition === opts.disposition &&
    (opts.disposition !== 'reclassified' ||
      existing.dispositionClassification === opts.classification)
  ) {
    return { updated: false, reason: 'already-disposed', entry: existing };
  }

  const updated: PendingExemplar = {
    ...existing,
    disposition: opts.disposition,
    dispositionAt: opts.now ?? new Date().toISOString(),
    ...(opts.classification !== undefined
      ? { dispositionClassification: opts.classification }
      : {}),
    ...(opts.rationale !== undefined ? { dispositionRationale: opts.rationale } : {}),
    ...(opts.by !== undefined ? { dispositionBy: opts.by } : {}),
  };

  entries[idx] = updated;
  writePendingExemplars(opts.repoRoot, entries, opts.path);
  return { updated: true, entry: updated };
}

// ── Re-affirm / re-classify CLI helpers (AC#6) ───────────────────────────────

export function affirmPendingExemplar(opts: {
  repoRoot: string;
  exemplarId: string;
  rationale?: string;
  by?: string;
  now?: string;
  path?: string;
}): SetDispositionResult {
  return setPendingExemplarDisposition({
    repoRoot: opts.repoRoot,
    exemplarId: opts.exemplarId,
    disposition: 'affirmed',
    ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
}

export function reclassifyPendingExemplar(opts: {
  repoRoot: string;
  exemplarId: string;
  classification: string;
  rationale?: string;
  by?: string;
  now?: string;
  path?: string;
}): SetDispositionResult {
  return setPendingExemplarDisposition({
    repoRoot: opts.repoRoot,
    exemplarId: opts.exemplarId,
    disposition: 'reclassified',
    classification: opts.classification,
    ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
}

export function rejectPendingExemplar(opts: {
  repoRoot: string;
  exemplarId: string;
  rationale?: string;
  by?: string;
  now?: string;
  path?: string;
}): SetDispositionResult {
  return setPendingExemplarDisposition({
    repoRoot: opts.repoRoot,
    exemplarId: opts.exemplarId,
    disposition: 'rejected',
    ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
}
