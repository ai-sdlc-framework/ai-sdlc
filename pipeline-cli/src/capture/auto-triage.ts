/**
 * RFC-0024 Refit Phase 3 — threshold-gated auto-triage + auto-severity
 * (AISDLC-275; OQ-2 + OQ-5 resolutions).
 *
 * Wires the AISDLC-321 shared classifier substrate (`@ai-sdlc/pipeline-cli`
 * `classifier.substrate`) into the capture-writer path. Produces a
 * triage / severity recommendation for a finding, gated on the
 * classifier's confidence vs. the per-org / per-task / per-agent
 * threshold (default 0.7). Callers (the `cli-capture file --json` AI-agent
 * path and the future TUI auto-triage badge) take the recommendation +
 * either auto-apply (high confidence → submit to team-shared) or queue
 * the capture as a draft with the unresolved sentinel (`triage: tbd` /
 * `severity: unknown`) for operator triage.
 *
 * **Substrate→capture taxonomy translation.** The substrate's
 * `capture-triage` prompt enum (`quick-fix-task | new-feature-issue |
 * scope-extension | won't-fix | tbd`) does NOT 1:1 map to the capture
 * record's `CaptureTriageValue` enum (`tbd | new-issue |
 * new-feature-issue | scope-extension | quick-fix | framework-bug |
 * not-actionable`). The mapping below is the only sanctioned bridge
 * between the two domains; downstream code MUST go through
 * `mapTriageClassification()` rather than ad-hoc casts. `framework-bug`
 * is intentionally NOT producible by auto-classification — that label
 * indicates the framework misbehaved (per RFC-0025), which is a
 * judgement call that belongs to the operator or the orchestrator
 * itself, not a Haiku-class classifier.
 *
 * **Why this lives in `capture/` not `classifier/substrate/`.** The
 * substrate is task-type-agnostic. The taxonomy bridge + per-agent
 * threshold lookup + corpus-entry-id stashing in the audit trail are
 * capture-specific concerns; keeping them next to the capture-writer
 * preserves the substrate's single-responsibility contract.
 *
 * @module capture/auto-triage
 */

import {
  classify,
  loadSubstrateConfig,
  recordOperatorOverride,
  type ClassifierDecision,
  type LlmInvoker,
  type SubscriptionLedgerWriter,
} from '../classifier/substrate/index.js';
import type {
  AgentRole,
  AuditEntry,
  CaptureRecord,
  CaptureSeverity,
  CaptureTriageValue,
} from './capture-record.js';

// ── Substrate → capture taxonomy mapping ─────────────────────────────────────

/**
 * Translate the substrate's `capture-triage` classification value into a
 * `CaptureTriageValue`. The substrate's enum is the LLM prompt's
 * vocabulary; the capture record's enum is the framework's persistent
 * vocabulary. Returns `null` for values that have no capture-record
 * equivalent (currently none — every substrate value maps to something
 * — but the signature keeps room for future divergence).
 *
 * Mapping rationale (per RFC-0024 §7 triage rubric):
 *   - `quick-fix-task`     → `quick-fix`        (label rename only)
 *   - `new-feature-issue`  → `new-feature-issue` (identity)
 *   - `scope-extension`    → `scope-extension`  (identity)
 *   - `won't-fix`          → `not-actionable`   (RFC-0024 §7 explicitly
 *                                                names "not-actionable"
 *                                                as the won't-fix bucket)
 *   - `tbd`                → `tbd`              (identity)
 *
 * Substrate values that should NOT round-trip to the capture record
 * (e.g. a hypothetical future `auto-route-to-rfc`) would return `null`
 * here so the caller can fall back to `tbd`.
 */
export function mapTriageClassification(substrateValue: string): CaptureTriageValue | null {
  switch (substrateValue) {
    case 'quick-fix-task':
      return 'quick-fix';
    case 'new-feature-issue':
      return 'new-feature-issue';
    case 'scope-extension':
      return 'scope-extension';
    case "won't-fix":
      return 'not-actionable';
    case 'tbd':
      return 'tbd';
    default:
      return null;
  }
}

/**
 * Translate the substrate's `capture-severity` classification value into
 * a `CaptureSeverity`. The substrate's enum is `low | medium | high |
 * critical`; the capture record's enum is `critical | major | minor |
 * suggestion | unknown`.
 *
 * Mapping rationale:
 *   - `critical` → `critical` (identity)
 *   - `high`     → `major`    (RFC-0024 §6 "major" is the high-risk
 *                              non-outage bucket)
 *   - `medium`   → `minor`    ("should fix soon; non-blocking")
 *   - `low`      → `suggestion` ("nice-to-have, no real risk")
 *
 * The capture record's `unknown` is intentionally NOT producible from a
 * successful classification — `unknown` is the sentinel for "no
 * inference attempted" or "inference fell open". When classification
 * fails (low confidence or substrate fell open), the caller leaves the
 * capture's severity as the pre-existing value (typically `unknown`).
 */
export function mapSeverityClassification(substrateValue: string): CaptureSeverity | null {
  switch (substrateValue) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'major';
    case 'medium':
      return 'minor';
    case 'low':
      return 'suggestion';
    default:
      return null;
  }
}

// ── Inputs + outputs ─────────────────────────────────────────────────────────

/**
 * Inputs for the auto-triage / auto-severity helpers. The helpers compose
 * the substrate's `classify()` call so callers don't have to thread the
 * task-type literal + taxonomy mapping themselves.
 */
export interface AutoClassifyOpts {
  /** The finding text — the substrate's primary signal. */
  finding: string;
  /** Optional source-context bag — passed through to the substrate prompt. */
  context?: Record<string, unknown>;
  /**
   * Agent role of the capture's source. Drives per-agent threshold
   * lookup (RFC-0024 OQ-2 / OQ-5 — AISDLC-275 AC-4). When omitted, the
   * substrate falls back to per-task / global / default thresholds.
   */
  agentRole?: AgentRole | null;
  /** Project root for config + corpus resolution. */
  repoRoot: string;
  /**
   * `LlmInvoker` to drive the classification. Required because the
   * substrate has no global invoker — pipeline-cli is SDK-free. Callers
   * wire an Anthropic Haiku adapter (or `FakeLlmInvoker` in tests). When
   * the caller can't supply an invoker (e.g. the CLI in a context with
   * no LLM access), they SHOULD skip auto-classification entirely
   * rather than calling these helpers — the helpers fall open
   * gracefully but spend a corpus slot for a `pending` entry.
   */
  invoker: LlmInvoker;
  /** Per-call confidence threshold override. */
  threshold?: number;
  /** Subscription-ledger writer for cost accounting (AC-9 from AISDLC-321). */
  ledgerWriter?: SubscriptionLedgerWriter;
  /** Corpus directory override (tests). */
  corpusDir?: string;
}

/**
 * Result of `autoTriageCapture()`. The caller decides what to do with
 * the recommendation based on `metBehindThreshold`:
 *
 *   - `metBehindThreshold: true`  → apply `recommendedTriage` and submit
 *                                   the capture to team-shared.
 *   - `metBehindThreshold: false` → leave the capture as `triage: tbd` /
 *                                   draft state; surfaces in operator
 *                                   review queue.
 *
 * `corpusEntryId` is the substrate's calibration-corpus entry id. The
 * caller MUST stash this id somewhere accessible at operator-override
 * time so `recordTriageOverride()` can flip the polarity. The standard
 * stash location is the `captured` audit entry's
 * `triageCorpusEntryId` extra field.
 *
 * `rawClassification` is the substrate's raw value (before taxonomy
 * translation) — useful for debugging when `recommendedTriage` is `null`
 * (the LLM returned a value our mapping doesn't recognise).
 */
export interface AutoTriageResult {
  /**
   * The capture-domain triage value to apply, OR `null` when the
   * substrate's classification didn't map to a known
   * `CaptureTriageValue` (treat as low-confidence; caller leaves
   * triage as `tbd`).
   */
  recommendedTriage: CaptureTriageValue | null;
  /** Did the classifier meet/exceed the effective threshold? */
  metBehindThreshold: boolean;
  /** The LLM's self-reported confidence in [0, 1]. */
  confidence: number;
  /** Effective threshold actually applied (per-call > per-agent > per-task > global). */
  effectiveThreshold: number;
  /** The LLM's reasoning — surfaced in TUI as the "AI rationale" hover. */
  reasoning: string;
  /** Substrate calibration-corpus entry id; pass to `recordTriageOverride()` on override. */
  corpusEntryId: string | null;
  /** Substrate's raw classification value (before taxonomy translation). */
  rawClassification: string;
  /** Model the substrate used (for audit). */
  model: string;
}

/**
 * Result of `autoInferSeverity()`. Symmetric to `AutoTriageResult` —
 * see that docstring for the field semantics.
 */
export interface AutoSeverityResult {
  recommendedSeverity: CaptureSeverity | null;
  metBehindThreshold: boolean;
  confidence: number;
  effectiveThreshold: number;
  reasoning: string;
  corpusEntryId: string | null;
  rawClassification: string;
  model: string;
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * RFC-0024 OQ-2 — threshold-gated capture-triage classifier (AC-1 + AC-2 +
 * AC-3 + AC-4 + AC-5).
 *
 * Invokes the substrate's `classify()` with the `capture-triage` task
 * type, translates the substrate's classification into a
 * `CaptureTriageValue`, and returns the decision + corpus-entry id for
 * later operator-override capture. Never throws — substrate failure
 * modes return a low-confidence result with `recommendedTriage: null`
 * which the caller treats as "fall back to `tbd`".
 *
 * Per-agent threshold lookup uses the substrate's per-org config block
 * (`classifier.perAgentRole[<role>].threshold` in
 * `.ai-sdlc/capture-config.yaml`); see `loadSubstrateConfig()` for the
 * resolution-order contract.
 */
export async function autoTriageCapture(opts: AutoClassifyOpts): Promise<AutoTriageResult> {
  const decision = await classifyForCapture(opts, 'capture-triage');
  const recommended = mapTriageClassification(decision.classification);
  return {
    recommendedTriage: recommended,
    metBehindThreshold: decision.metBehindThreshold && recommended !== null,
    confidence: decision.confidence,
    effectiveThreshold: decision.effectiveThreshold,
    reasoning: decision.reasoning,
    corpusEntryId: decision.corpusEntryId,
    rawClassification: decision.classification,
    model: decision.model,
  };
}

/**
 * RFC-0024 OQ-5 — threshold-gated capture-severity classifier (AC-5).
 *
 * Symmetric to `autoTriageCapture()`. Returns
 * `recommendedSeverity: null` when the substrate's classification
 * doesn't map to a known `CaptureSeverity` (treat as low-confidence;
 * caller leaves severity as `unknown`).
 */
export async function autoInferSeverity(opts: AutoClassifyOpts): Promise<AutoSeverityResult> {
  const decision = await classifyForCapture(opts, 'capture-severity');
  const recommended = mapSeverityClassification(decision.classification);
  return {
    recommendedSeverity: recommended,
    metBehindThreshold: decision.metBehindThreshold && recommended !== null,
    confidence: decision.confidence,
    effectiveThreshold: decision.effectiveThreshold,
    reasoning: decision.reasoning,
    corpusEntryId: decision.corpusEntryId,
    rawClassification: decision.classification,
    model: decision.model,
  };
}

// ── Effective-threshold preview (for TUI / dry-run) ──────────────────────────

/**
 * Compute the effective threshold the substrate WOULD apply for a given
 * `(taskType, agentRole)` pair, without invoking the LLM. Surfaces the
 * resolution-order outcome so the TUI's "AI auto-triaged this; confirm?"
 * badge can display the threshold the classification was measured
 * against. Pure of side-effects.
 */
export function previewEffectiveThreshold(opts: {
  taskType: 'capture-triage' | 'capture-severity';
  repoRoot: string;
  agentRole?: AgentRole | null;
  perCallThreshold?: number;
}): number {
  if (typeof opts.perCallThreshold === 'number') return opts.perCallThreshold;
  const cfg = loadSubstrateConfig(opts.taskType, opts.repoRoot, opts.agentRole ?? undefined);
  return cfg.threshold;
}

// ── Audit-trail-aware decoration ─────────────────────────────────────────────

/**
 * Attach the substrate's corpus-entry ids to the `captured` audit entry
 * so a future `recordTriageOverride()` / `recordSeverityOverride()` can
 * locate the corpus row to flip. The audit entry's open-extension shape
 * (`[key: string]: unknown` on `AuditEntry`) is the right place for this
 * — the capture record's persistent schema stays unchanged.
 *
 * Mutates the supplied audit entry in-place AND returns it for chained
 * use. Skips the field when the corresponding id is `null`.
 */
export function decorateCapturedAuditEntry(
  entry: AuditEntry,
  classification: {
    triageCorpusEntryId?: string | null;
    severityCorpusEntryId?: string | null;
  },
): AuditEntry {
  if (classification.triageCorpusEntryId) {
    entry.triageCorpusEntryId = classification.triageCorpusEntryId;
  }
  if (classification.severityCorpusEntryId) {
    entry.severityCorpusEntryId = classification.severityCorpusEntryId;
  }
  return entry;
}

/**
 * Extract the corpus-entry ids the `captured` audit entry was decorated
 * with. Returns `{ triage: null, severity: null }` when the entry was
 * not auto-classified or the record is malformed. Pure of I/O.
 */
export function extractCorpusEntryIds(record: CaptureRecord): {
  triage: string | null;
  severity: string | null;
} {
  const captured = record.auditTrail.find((e) => e.action === 'captured');
  if (!captured) return { triage: null, severity: null };
  const triage =
    typeof captured.triageCorpusEntryId === 'string' ? captured.triageCorpusEntryId : null;
  const severity =
    typeof captured.severityCorpusEntryId === 'string' ? captured.severityCorpusEntryId : null;
  return { triage, severity };
}

// ── Operator-override capture (AC-6) ─────────────────────────────────────────

/**
 * Record an operator override of an auto-triaged capture (AC-6). Looks
 * up the substrate corpus entry by id (stashed in the `captured` audit
 * entry's `triageCorpusEntryId` field) and flips its polarity to
 * `negative`. The new (operator-chosen) classification is mapped BACK to
 * the substrate's taxonomy before being recorded, so the corpus stores
 * the substrate's vocabulary consistently.
 *
 * No-op when the original capture wasn't auto-triaged (no
 * `triageCorpusEntryId` in the audit trail). The caller should still
 * proceed with the operator's chosen triage — the override-capture
 * failure to find a corpus entry is not a triage failure.
 */
export function recordTriageOverride(opts: {
  record: CaptureRecord;
  newTriage: CaptureTriageValue;
  reason?: string;
  repoRoot: string;
  now?: string;
  corpusDir?: string;
}): ReturnType<typeof recordOperatorOverride> {
  const ids = extractCorpusEntryIds(opts.record);
  return recordOperatorOverride({
    repoRoot: opts.repoRoot,
    taskType: 'capture-triage',
    corpusEntryId: ids.triage,
    newClassification: reverseMapTriageClassification(opts.newTriage),
    reason: opts.reason,
    now: opts.now,
    corpusDir: opts.corpusDir,
  });
}

/**
 * Record an operator override of an auto-inferred severity (AC-6 for
 * the severity arc). Symmetric to `recordTriageOverride()`.
 */
export function recordSeverityOverride(opts: {
  record: CaptureRecord;
  newSeverity: CaptureSeverity;
  reason?: string;
  repoRoot: string;
  now?: string;
  corpusDir?: string;
}): ReturnType<typeof recordOperatorOverride> {
  const ids = extractCorpusEntryIds(opts.record);
  return recordOperatorOverride({
    repoRoot: opts.repoRoot,
    taskType: 'capture-severity',
    corpusEntryId: ids.severity,
    newClassification: reverseMapSeverityClassification(opts.newSeverity),
    reason: opts.reason,
    now: opts.now,
    corpusDir: opts.corpusDir,
  });
}

// ── Reverse mappings (capture-domain → substrate vocabulary) ─────────────────

/**
 * Reverse of `mapTriageClassification`. Used to translate an operator's
 * chosen `CaptureTriageValue` back into the substrate's prompt
 * vocabulary so the corpus's `operatorOverrideClassification` field
 * stays in the substrate's domain (one consistent enum per task type).
 *
 * Capture-record values that have no substrate equivalent
 * (`new-issue`, `framework-bug`) map to themselves — the operator's
 * override may indicate the LLM's enum is too narrow, and recording the
 * raw capture-domain value is more useful than dropping the signal.
 */
function reverseMapTriageClassification(captureValue: CaptureTriageValue): string {
  switch (captureValue) {
    case 'quick-fix':
      return 'quick-fix-task';
    case 'new-feature-issue':
      return 'new-feature-issue';
    case 'scope-extension':
      return 'scope-extension';
    case 'not-actionable':
      return "won't-fix";
    case 'tbd':
      return 'tbd';
    case 'new-issue':
    case 'framework-bug':
      // No substrate equivalent — record raw value so the corpus
      // analytics can surface "operators frequently override to <value>
      // which we don't model" as a prompt-tuning signal.
      return captureValue;
  }
}

/**
 * Reverse of `mapSeverityClassification`. Capture's `unknown` sentinel
 * has no substrate equivalent — we map it to `low` because an operator
 * downgrading from an auto-`high` to `unknown` reads as "the inference
 * was over-confident on the high side". `low` is the closest substrate
 * value that conveys "the LLM was wrong toward high".
 */
function reverseMapSeverityClassification(captureValue: CaptureSeverity): string {
  switch (captureValue) {
    case 'critical':
      return 'critical';
    case 'major':
      return 'high';
    case 'minor':
      return 'medium';
    case 'suggestion':
      return 'low';
    case 'unknown':
      return 'low';
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function classifyForCapture(
  opts: AutoClassifyOpts,
  taskType: 'capture-triage' | 'capture-severity',
): Promise<ClassifierDecision> {
  return classify({ text: opts.finding, context: opts.context }, taskType, {
    invoker: opts.invoker,
    repoRoot: opts.repoRoot,
    agentRole: opts.agentRole ?? undefined,
    threshold: opts.threshold,
    ledgerWriter: opts.ledgerWriter,
    corpusDir: opts.corpusDir,
  });
}
