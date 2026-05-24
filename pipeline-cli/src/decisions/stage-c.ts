/**
 * RFC-0035 Phase 5 — Stage C LLM evaluation runner (AISDLC-289).
 *
 * Stage C is the LLM-as-last-resort tier. It fires only when Stage B's
 * composite confidence lands in the mid-band `[0.4, 0.7]` per §5.3
 * (outside that band Stage B is already confident or already certain-it-
 * needs-operator). When it fires, Stage C calls the shared classifier
 * substrate (`pipeline-cli/src/classifier/substrate/` — AISDLC-321 /
 * RFC-0024 Phase 2) with `taskType: 'decision-recommendation'` and asks
 * the LLM to recommend an option-id from the decision's option list.
 *
 * ### Composition with the shared substrate
 *
 * Per the task brief, Stage C **composes** rather than duplicates. The
 * substrate already provides:
 *   - Prompt template (`buildPrompt('decision-recommendation', input)`)
 *   - Response validation against the option-id allowlist
 *   - Corpus capture per task type (`classifier-corpus/decision-recommendation.yaml`)
 *   - Operator-override capture (`recordOperatorOverride()`)
 *   - Silence-as-positive sweeper (`resolveSilenceAsPositive()`)
 *   - Per-call threshold + model override
 *
 * Stage C wraps the substrate to translate Decision-record shapes (options
 * list, summary, body) into the substrate's `ClassifierInput` shape and
 * back. It also adds the Decision-Catalog-specific bits:
 *   - Auto-apply gate (`reversible && metBehindThreshold && llmAnswerEligible`)
 *   - Mid-band guard (won't fire when Stage B already resolved)
 *   - Event factories (`makeStageCCompletedEvent`, `makeStageCOperatorAnsweredEvent`)
 *
 * ### Auto-apply + 24h override window (OQ-3 resolution)
 *
 * When Stage C's recommendation meets the confidence threshold AND the
 * decision is reversible, Stage C auto-applies the recommendation — emits
 * BOTH a `stage-c-completed` event (autoApplied: true) AND an
 * `operator-answered` event (by: 'framework') in the same tick. The
 * override window is initiated by the substrate's corpus entry timestamp;
 * the substrate's existing override + silence-sweeper flow handles
 * polarity assignment. An operator override during the window emits an
 * `overridden` event and calls `recordOperatorOverride()` to flip the
 * corpus polarity to `negative`. Silence past the window — handled by the
 * substrate sweeper — promotes the corpus entry to `positive`.
 *
 * ### Acceptance Criteria
 *
 * - AC#1 Stage C LLM classifier ships behind feature flag (composes with
 *   `isDecisionCatalogEnabled()` — see `feature-flag.ts`).
 * - AC#3 Confidence threshold 0.7 default, configurable via
 *   `decisions-config.yaml: stageCConfidenceThreshold`.
 * - AC#4 Shared corpus aggregator (composes with substrate corpus — see
 *   `corpus-aggregator.ts`).
 * - AC#5 Auto-apply with 24h override window for reversible decisions; the
 *   24h window is per-org configurable via `decisions-config.yaml:
 *   overrideWindowHours` (already shipped in decisions-config).
 * - AC#6 Operator override → negative exemplar (via substrate
 *   `recordOperatorOverride`); silence → positive exemplar (via substrate
 *   `resolveSilenceAsPositive`).
 * - AC#7 Override window per-org configurable (already in
 *   `decisions-config.yaml: overrideWindowHours`).
 *
 * @module decisions/stage-c
 */

import {
  classify,
  type ClassifierInput,
  type ClassifyOpts,
  type LlmInvoker,
} from '../classifier/substrate/index.js';

import type {
  Decision,
  OperatorAnsweredEvent,
  OverriddenEvent,
  StageBOutput,
  StageCCompletedEvent,
  StageCOutput,
  StageCRecommendation,
} from './decision-record.js';
import { resolveDecisionsConfig, type DecisionsConfig } from './decisions-config.js';

// ── Threshold + mid-band constants (RFC-0035 §5.3) ───────────────────────────

/**
 * Default Stage C confidence threshold (AC#3). Mirrors the substrate's
 * `DEFAULT_CONFIDENCE_THRESHOLD` (0.7) so the same number lives in one
 * place per `decisions-config.yaml: stageCConfidenceThreshold` override.
 */
export const STAGE_C_DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Stage B composite-score band in which Stage C fires (§5.3). Outside this
 * band the LLM call has no marginal value over the rubric.
 */
export const STAGE_C_MID_BAND_LOW = 0.4;
export const STAGE_C_MID_BAND_HIGH = 0.7;

/**
 * Resolve the effective Stage C confidence threshold from a loaded
 * `decisions-config.yaml`. Falls back to the default when the field is
 * missing or non-finite. Threshold values outside `(0, 1)` are clamped
 * with a warning written to stderr (the caller can ignore it; the
 * threshold is bounded by domain definition).
 */
export function resolveStageCThreshold(loaded: DecisionsConfig): number {
  const raw = loaded.stageCConfidenceThreshold;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return STAGE_C_DEFAULT_CONFIDENCE_THRESHOLD;
  }
  if (raw <= 0 || raw >= 1) {
    process.stderr.write(
      `[stage-c] decisions-config.yaml: stageCConfidenceThreshold=${raw} is out of (0,1) — falling back to default ${STAGE_C_DEFAULT_CONFIDENCE_THRESHOLD}\n`,
    );
    return STAGE_C_DEFAULT_CONFIDENCE_THRESHOLD;
  }
  return raw;
}

// ── Mid-band guard ────────────────────────────────────────────────────────────

/**
 * Whether Stage C should fire on a decision given its Stage B output.
 *
 * Per §5.3: Stage C fires only in the mid-band `[0.4, 0.7]`. Outside that
 * range Stage B is either already confident (high band) or already
 * certain-it-needs-operator (low band). Stage C also fires when Stage B is
 * missing (no rubric ran yet) so callers can invoke it directly for
 * exploration / spot-checks.
 *
 * Pass `forceFire: true` to bypass the band check (used by the CLI
 * `score-c --force` flag for operator spot-checks).
 */
export function shouldFireStageC(stageB: StageBOutput | undefined, forceFire = false): boolean {
  if (forceFire) return true;
  if (!stageB) return true; // exploratory / spot-check path
  const c = stageB.compositeScore;
  return c >= STAGE_C_MID_BAND_LOW && c < STAGE_C_MID_BAND_HIGH;
}

// ── Stage C runner ────────────────────────────────────────────────────────────

export interface RunStageCInput {
  /** The decision being evaluated. */
  decision: Decision;
  /** Stage B output. Optional — Stage C can be invoked standalone for spot-checks. */
  stageB?: StageBOutput;
  /** LLM invoker injected by the caller (mirrors substrate convention). */
  invoker?: LlmInvoker;
  /** Project root — passed to the substrate for config + corpus paths. */
  workDir?: string;
  /** Per-call confidence threshold override. */
  threshold?: number;
  /** Model override (e.g. for A/B). */
  model?: string;
  /** Corpus directory override (tests). */
  corpusDir?: string;
  /**
   * Bypass the mid-band fire guard. Used by the CLI for operator
   * spot-checks against decisions Stage B already resolved.
   */
  forceFire?: boolean;
  /**
   * Optional `now` for tests + deterministic event timestamps. Real
   * callers leave this undefined.
   */
  now?: Date;
}

export interface RunStageCResult {
  /** True when Stage C fired (substrate was called). False when mid-band guard skipped. */
  fired: boolean;
  /** Stage C output (when `fired: true`); null when guard skipped. */
  stageC: StageCOutput | null;
  /**
   * Reason when `fired: false`. One of:
   *   - 'stage-b-high-band' — composite ≥ 0.7
   *   - 'stage-b-low-band'  — composite < 0.4
   *   - 'invoker-missing'   — no LLM invoker supplied (guards against silent fall-open)
   */
  skipReason?: 'stage-b-high-band' | 'stage-b-low-band' | 'invoker-missing';
}

/**
 * Run Stage C LLM evaluation on a decision via the shared classifier
 * substrate. Returns a `StageCOutput` describing the recommendation +
 * whether the framework MAY auto-apply (see `llmAnswerEligible` +
 * `metBehindThreshold`).
 *
 * **Mid-band guard**: short-circuits when Stage B is already confident.
 * Use `forceFire: true` to bypass (CLI spot-check).
 *
 * **Substrate fall-open**: when the invoker is missing or fails, the
 * substrate returns a `pending` sentinel with confidence 0. Stage C
 * propagates this as `metBehindThreshold: false` + `llmAnswerEligible:
 * false` + an `error` field on the output so the operator path remains
 * the safe default.
 *
 * **Auto-apply gate**: the caller decides whether to emit the companion
 * `operator-answered` event by inspecting `stageC.llmAnswerEligible &&
 * stageC.metBehindThreshold && decision.spec.reversible !== false`. See
 * `makeStageCAutoApplyEvent()` for the helper.
 */
export async function runStageC(input: RunStageCInput): Promise<RunStageCResult> {
  const fire = shouldFireStageC(input.stageB, input.forceFire ?? false);
  if (!fire) {
    const c = input.stageB?.compositeScore ?? 0;
    return {
      fired: false,
      stageC: null,
      skipReason: c >= STAGE_C_MID_BAND_HIGH ? 'stage-b-high-band' : 'stage-b-low-band',
    };
  }

  // Build substrate input from the Decision's option list.
  const optionIds = input.decision.spec.options.map((o) => o.id);
  const optionDescriptions: Record<string, string> = {};
  for (const opt of input.decision.spec.options) {
    optionDescriptions[opt.id] = opt.description;
  }

  const classifierInput: ClassifierInput = {
    text: input.decision.spec.summary,
    context: {
      optionIds,
      optionDescriptions,
      ...(input.decision.spec.body ? { body: input.decision.spec.body } : {}),
      decisionId: input.decision.metadata.id,
      scope: input.decision.metadata.scope,
    },
  };

  const classifyOpts: ClassifyOpts = {};
  if (input.invoker) classifyOpts.invoker = input.invoker;
  if (input.workDir) classifyOpts.repoRoot = input.workDir;
  if (input.threshold !== undefined) classifyOpts.threshold = input.threshold;
  if (input.model) classifyOpts.model = input.model;
  if (input.corpusDir) classifyOpts.corpusDir = input.corpusDir;

  const decision = await classify(classifierInput, 'decision-recommendation', classifyOpts);

  // The substrate has already validated that `classification` is one of the
  // option ids (when the LLM responded properly). When it isn't (invoker
  // missing, fall-open), classification === 'pending' and confidence === 0.
  const llmAnswerEligible =
    decision.metBehindThreshold && optionIds.includes(decision.classification);

  const recommendation: StageCRecommendation = {
    optionId: decision.classification,
    confidence: decision.confidence,
    rationale: decision.reasoning,
  };

  const stageC: StageCOutput = {
    corpusEntryId: decision.corpusEntryId,
    effectiveThreshold: decision.effectiveThreshold,
    model: decision.model,
    metBehindThreshold: decision.metBehindThreshold,
    recommendation,
    // Phase 5 leaves the richer surface empty per task brief — Phase 6+
    // (decision support surface, AISDLC-290) adds counter-arguments,
    // alternatives, and sub-decisions.
    alternativesConsidered: [],
    counterArguments: [],
    subDecisionsImplied: [],
    llmAnswerEligible,
  };

  if (!decision.metBehindThreshold && decision.reasoning.startsWith('(')) {
    // Reasoning like '(invoker error: ...)' / '(invalid response: ...)' is
    // the substrate's fall-open signal. Surface it explicitly.
    stageC.error = decision.reasoning;
  }

  return { fired: true, stageC };
}

// ── Auto-apply gate ───────────────────────────────────────────────────────────

/**
 * Whether the framework MAY auto-apply Stage C's recommendation per
 * OQ-3 / OQ-12. Auto-apply is gated on THREE conditions:
 *
 *   1. The Stage C output is LLM-answer-eligible (high confidence + a
 *      recognised option-id).
 *   2. The decision is reversible (`spec.reversible !== false` — default
 *      true). Irreversible decisions fall through to explicit confirm.
 *   3. The Stage C output succeeded (no `error` field).
 *
 * Returns `false` when any of these is missing. Callers that want to
 * surface the recommendation as a suggestion (operator-confirm path)
 * proceed even when this returns false.
 */
export function isStageCAutoApplyEligible(
  decision: Decision,
  stageC: StageCOutput | null,
): boolean {
  if (stageC === null) return false;
  if (stageC.error) return false;
  if (!stageC.llmAnswerEligible) return false;
  if (decision.spec.reversible === false) return false;
  return true;
}

// ── Event factories ───────────────────────────────────────────────────────────

export interface MakeStageCCompletedEventInput {
  decisionId: string;
  stageC: StageCOutput;
  /** Whether the framework auto-applied (companion `operator-answered` event also emitted). */
  autoApplied: boolean;
  by?: string;
  now?: Date;
}

/**
 * Build a well-formed `stage-c-completed` event. Caller passes to
 * `appendDecisionEvent` to persist. When `autoApplied: true`, the caller
 * MUST also emit a companion `operator-answered` event via
 * `makeStageCAutoApplyAnsweredEvent()`.
 */
export function makeStageCCompletedEvent(
  input: MakeStageCCompletedEventInput,
): StageCCompletedEvent {
  const ts = (input.now ?? new Date()).toISOString();
  // Annotate the stage-c payload with the auto-apply timestamp + override
  // window when the framework is acting; the corpus entry's timestamp
  // anchors the window so we mirror that here for log-readers.
  const stageC: StageCOutput = { ...input.stageC };
  if (input.autoApplied && stageC.autoApplyAt === undefined) {
    stageC.autoApplyAt = ts;
  }
  const evt: StageCCompletedEvent = {
    eventVersion: 'v1',
    type: 'stage-c-completed',
    ts,
    decisionId: input.decisionId,
    stageC,
    autoApplied: input.autoApplied,
  };
  if (input.by !== undefined) evt.by = input.by;
  return evt;
}

export interface MakeStageCAutoApplyAnsweredEventInput {
  decisionId: string;
  chosenOptionId: string;
  rationale?: string;
  now?: Date;
}

/**
 * Build the companion `operator-answered` event when Stage C auto-applies.
 * `by: 'framework'` distinguishes auto-applied answers from operator-
 * authored ones in the digest + override pathway. The rationale is the
 * LLM's recommendation rationale carried forward so post-mortem auditors
 * see why the framework picked the option.
 */
export function makeStageCAutoApplyAnsweredEvent(
  input: MakeStageCAutoApplyAnsweredEventInput,
): OperatorAnsweredEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const evt: OperatorAnsweredEvent = {
    eventVersion: 'v1',
    type: 'operator-answered',
    ts,
    decisionId: input.decisionId,
    chosenOptionId: input.chosenOptionId,
    by: 'framework',
  };
  if (input.rationale !== undefined) evt.rationale = input.rationale;
  return evt;
}

// ── Override event factory (AC#6) ─────────────────────────────────────────────

export interface MakeOverriddenEventInput {
  decisionId: string;
  chosenOptionId: string;
  /** The option id the framework had auto-applied. */
  supersededOptionId: string;
  rationale?: string;
  by?: string;
  now?: Date;
}

/**
 * Build a well-formed `overridden` event. Emitted when the operator
 * overrides a framework auto-applied recommendation. The caller pairs
 * this with a substrate `recordOperatorOverride()` call to flip the
 * corpus polarity to `negative` (AC#6).
 */
export function makeOverriddenEvent(input: MakeOverriddenEventInput): OverriddenEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const evt: OverriddenEvent = {
    eventVersion: 'v1',
    type: 'overridden',
    ts,
    decisionId: input.decisionId,
    chosenOptionId: input.chosenOptionId,
    supersededOptionId: input.supersededOptionId,
  };
  if (input.rationale !== undefined) evt.rationale = input.rationale;
  if (input.by !== undefined) evt.by = input.by;
  return evt;
}

// ── Resolve threshold helper for callers ──────────────────────────────────────

/**
 * Convenience wrapper that calls `resolveDecisionsConfig()` and extracts
 * the effective Stage C threshold + override window in one call. Used by
 * the CLI + the orchestrator integration to keep the resolution chain
 * in one place.
 */
export function resolveStageCRuntimeConfig(loaded: DecisionsConfig): {
  threshold: number;
  overrideWindowHours: number;
} {
  const resolved = resolveDecisionsConfig(loaded);
  return {
    threshold: resolveStageCThreshold(loaded),
    overrideWindowHours: resolved.overrideWindowHours,
  };
}
