/**
 * RFC-0035 Phase 3 — Stage B rubric scorer (deterministic dimensions only).
 *
 * Implements §5.2 structural rubrics for decisions that Stage A could not
 * fully resolve, or to supplement Stage A with richer multi-dimensional
 * scoring. Stage B evaluates four dimensions:
 *
 * 1. **Load-bearing-ness** — reversibility, blast radius, downstream-decision
 *    count, deadline-criticality (3/4 deterministic in Phase 3).
 * 2. **LLM-confidence** — RFC-stated-position presence, evidence-completeness
 *    (deterministic subset; novelty + exemplar-similarity default to 0.5 as
 *    conservative placeholders until Phase 5 adds the Haiku-class LLM calls).
 * 3. **Actor-fit** — declared-pillar match, capacity availability
 *    (fully deterministic given pillar tagging from RFC-0029).
 * 4. **Cost-of-block** — blockedTaskCount × tier-weight, deadline distance
 *    (fully deterministic from dep-graph + Decision fields).
 *
 * ### Actor routing §6.2
 *
 * ```
 * single-pillar decision           → assign to that pillar's owner
 * multi-pillar decision            → assign to operator; sub-actors = pillar owners
 * LLM-eligible (Stage A+B)         → assign to framework (auto-decide; digest)
 * load-bearing + ambiguous pillar  → assign to operator with escalation note
 * ```
 *
 * ### Acceptance Criteria
 *
 * - AC#1: Rubric scorer evaluates Engineering + Product + Operator pillars.
 * - AC#2: Actor routing returns single primary actor + sub-actor list.
 * - AC#3: Multi-actor decisions populate `subActors` with pillar owners.
 * - AC#4: `PillarOwnerConfig` is partial — sub-actors never auto-fills missing
 *   pillars (composition with team-roles convention).
 * - AC#5: No LLM calls — all dimensions are synchronous and deterministic.
 * - AC#6: `routing.rationale` stored on Decision record via `recommendation-issued`
 *   event → projection into `status.routing.actorRationale`.
 *
 * @module decisions/stage-b
 */

import type {
  Decision,
  DecisionRouting,
  DecisionTier,
  RecommendationIssuedEvent,
  StageBActorFitScore,
  StageBActorRoute,
  StageBCostOfBlockScore,
  StageBLlmConfidenceScore,
  StageBLoadBearingScore,
  StageBOutput,
  StageBRubricScores,
  StageAOutput,
} from './decision-record.js';

// ── Pillar owner configuration (RFC-0029 three-pillar model) ─────────────────

/**
 * Operator-configurable pillar owner map (§6.2).
 *
 * All fields are optional — AC#4: the router only adds configured owners to
 * `subActors`; missing pillars are NEVER auto-filled. This composes with the
 * team-roles convention where not all three pillars may be configured in v1.
 *
 * Default values ship as constants in `DEFAULT_PILLAR_OWNERS` (empty — no
 * implicit defaults so the composition constraint is provably correct).
 */
export interface PillarOwnerConfig {
  /** Email / identifier for the Engineering pillar owner (§6.1). */
  engineering?: string;
  /** Email / identifier for the Product pillar owner (§6.1). */
  product?: string;
  /** Email / identifier for the Design pillar owner (§6.1). */
  design?: string;
  /** Email / identifier for the Operator role (cross-pillar decisions, §6.2). */
  operator?: string;
}

/**
 * Default pillar owner config: empty, no implicit actors.
 *
 * AC#4: by shipping the default as an empty object rather than a hard-coded
 * email map, Stage B can never silently claim "all three pillars are covered"
 * — the caller must explicitly configure the owners they have.
 */
export const DEFAULT_PILLAR_OWNERS: PillarOwnerConfig = {};

// ── Tier weights for cost-of-block ───────────────────────────────────────────

/**
 * Per-tier urgency weight for the cost-of-block rubric.
 * Higher tier → higher weight (a decision that blocks XL work costs more).
 */
export const TIER_WEIGHTS: Record<DecisionTier, number> = {
  xs: 0.1,
  s: 0.25,
  m: 0.5,
  l: 0.75,
  xl: 1.0,
};

// ── Stage B thresholds ───────────────────────────────────────────────────────

/**
 * Composite-score threshold above which Stage B considers the decision
 * resolved (no Stage C LLM needed). Per §5.3: the LLM fires only for the
 * mid-band [0.4, 0.7].
 */
export const STAGE_B_HIGH_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Composite-score threshold below which the decision is considered
 * low-confidence by Stage B (no recommendation offered; Stage C would
 * provide options + research suggestions with < 0.5 confidence).
 */
export const STAGE_B_LOW_CONFIDENCE_THRESHOLD = 0.4;

/**
 * LLM-confidence rubric threshold: above this value the decision is eligible
 * for LLM auto-resolution when also reversible + low blast-radius.
 */
export const STAGE_B_LLM_ELIGIBLE_THRESHOLD = 0.7;

/**
 * Blast-radius cap for LLM-eligible decisions. Decisions blocking more than
 * this many tasks are load-bearing and not auto-resolved even if LLM-eligible.
 */
export const STAGE_B_LLM_ELIGIBLE_MAX_TASKS = 5;

// ── 1. Load-bearing-ness rubric ───────────────────────────────────────────────

/**
 * Score the load-bearing-ness rubric (§5.2 — 3/4 deterministic).
 *
 * Dimensions and weights:
 *   reversibility      (30%) — one-way=1.0, unknown=0.5, reversible=0.0
 *   blast radius       (35%) — log-diminishing per OQ-2
 *   downstream count   (15%) — decision tree depth / 5, capped at 1.0
 *   deadline-criticality (20%) — urgency based on days-until-deadline
 */
export function scoreLoadBearing(
  reversibility: 'reversible' | 'one-way' | 'unknown',
  blockedTaskCount: number,
  decisionTreeDepth: number,
  deadline?: string | null,
): StageBLoadBearingScore {
  // Reversibility sub-score
  const reversibilityScore =
    reversibility === 'one-way' ? 1.0 : reversibility === 'unknown' ? 0.5 : 0.0;

  // Blast-radius sub-score — log-diminishing per OQ-2 formula
  const blastRadiusScore = Math.min(Math.log1p(blockedTaskCount) / Math.log1p(20), 1.0);

  // Downstream-decision count sub-score (from subDecisions depth, Phase 2 measure)
  const downstreamDecisionsScore = Math.min(decisionTreeDepth / 5, 1.0);

  // Deadline-criticality sub-score
  let deadlineCriticality = 0.0;
  if (deadline) {
    const daysUntil = (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntil <= 0)
      deadlineCriticality = 1.0; // overdue
    else if (daysUntil <= 3)
      deadlineCriticality = 0.9; // extremely urgent
    else if (daysUntil <= 7)
      deadlineCriticality = 0.7; // very urgent
    else if (daysUntil <= 30)
      deadlineCriticality = 0.4; // upcoming
    else deadlineCriticality = 0.1; // far future
  }

  const score =
    reversibilityScore * 0.3 +
    blastRadiusScore * 0.35 +
    downstreamDecisionsScore * 0.15 +
    deadlineCriticality * 0.2;

  return {
    score: Math.round(score * 1000) / 1000,
    reversibility: reversibilityScore,
    blastRadius: blastRadiusScore,
    downstreamDecisions: downstreamDecisionsScore,
    deadlineCriticality,
  };
}

// ── 2. LLM-confidence rubric ──────────────────────────────────────────────────

/**
 * Score the LLM-confidence rubric (§5.2 — deterministic subset only).
 *
 * Phase 3 implements 2/4 deterministic dimensions:
 *   rfcStatedPositionPresence (30%) — body mentions an RFC resolution/position
 *   evidenceCompleteness      (40%) — has body + options with consequences
 *
 * Phase 5 placeholders (both default to 0.5 — conservative mid-band):
 *   novelty           (15%) — degree of novelty vs exemplar history (LLM)
 *   exemplarSimilarity (15%) — similarity to labelled exemplars (LLM)
 *
 * AC#5 — No LLM calls: novelty and exemplarSimilarity are 0.5 until Phase 5.
 */
export function scoreLlmConfidence(decision: Decision): StageBLlmConfidenceScore {
  const bodyText = decision.spec.body ?? '';

  // RFC stated position: does the body reference an RFC resolution or stated position?
  const rfcPositionPresent =
    /rfc-\d+|resolution:|per rfc|rfc states|stated position|rfc says|resolved:/i.test(bodyText);
  const rfcStatedPositionPresence = rfcPositionPresent ? 1.0 : 0.0;

  // Evidence completeness: has body + at least some options with consequences
  const hasBody = bodyText.trim().length > 0;
  const optionsWithConsequences = (decision.spec.options ?? []).filter(
    (o) => (o.consequences?.length ?? 0) > 0,
  ).length;
  const totalOptions = (decision.spec.options ?? []).length;
  const consequenceCoverage =
    totalOptions > 0 ? Math.min(optionsWithConsequences / totalOptions, 1.0) : 0;
  const evidenceCompleteness = (hasBody ? 0.5 : 0) + consequenceCoverage * 0.5;

  // Phase 3 placeholders — conservative 0.5 (neither confident nor unconfident)
  const novelty = 0.5;
  const exemplarSimilarity = 0.5;

  const score =
    rfcStatedPositionPresence * 0.3 +
    evidenceCompleteness * 0.4 +
    novelty * 0.15 +
    exemplarSimilarity * 0.15;

  return {
    score: Math.round(score * 1000) / 1000,
    rfcStatedPositionPresence,
    evidenceCompleteness: Math.round(evidenceCompleteness * 1000) / 1000,
    novelty,
    exemplarSimilarity,
  };
}

// ── 3. Actor-fit rubric ───────────────────────────────────────────────────────

/**
 * Score the actor-fit rubric (§5.2 — fully deterministic given pillar tagging).
 *
 * Dimensions and weights:
 *   declaredPillarMatch (35%) — single-pillar=1.0, multi-pillar=0.5, none=0.0
 *   capacityAvailability (25%) — withinBudget=1.0, over budget=0.0
 *   overrideHistoryFit  (20%) — 0.5 placeholder until Phase 9
 *   expertiseTagMatch   (20%) — 0.5 placeholder until Phase 9
 */
export function scoreActorFit(
  affectedPillars: string[],
  capacityCheck: { withinBudget: boolean },
): StageBActorFitScore {
  // Single clear pillar = best fit; multi-pillar = ambiguous; none = unknown
  const declaredPillarMatch =
    affectedPillars.length === 1 ? 1.0 : affectedPillars.length === 0 ? 0.0 : 0.5;
  const capacityAvailability = capacityCheck.withinBudget ? 1.0 : 0.0;
  // Phase 3 placeholders
  const overrideHistoryFit = 0.5;
  const expertiseTagMatch = 0.5;

  const score =
    declaredPillarMatch * 0.35 +
    capacityAvailability * 0.25 +
    overrideHistoryFit * 0.2 +
    expertiseTagMatch * 0.2;

  return {
    score: Math.round(score * 1000) / 1000,
    declaredPillarMatch,
    capacityAvailability,
    overrideHistoryFit,
    expertiseTagMatch,
  };
}

// ── 4. Cost-of-block rubric ───────────────────────────────────────────────────

/**
 * Score the cost-of-block rubric (§5.2 — fully deterministic).
 *
 * Dimensions and weights:
 *   taskBlockScore   (60%) — log-normalised blockedTaskCount × tier-weight
 *   deadlineScore    (40%) — urgency based on days-until-deadline
 *   downstreamPRScore (0%) — 0.0 until Phase 8 (no PR data)
 */
export function scoreCostOfBlock(
  blockedTaskCount: number,
  tier?: DecisionTier | string,
  deadline?: string | null,
): StageBCostOfBlockScore {
  // Tier weight (default to mid-band when unset)
  const tierWeight = tier ? (TIER_WEIGHTS[tier as DecisionTier] ?? 0.5) : 0.5;

  // Count × tier: combine log-diminishing count with tier-weight
  const countNorm = Math.min(Math.log1p(blockedTaskCount) / Math.log1p(20), 1.0);
  const taskBlockScore = (countNorm + tierWeight) / 2;

  // Deadline distance
  let deadlineScore = 0.0;
  if (deadline) {
    const daysUntil = (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntil <= 0) deadlineScore = 1.0;
    else if (daysUntil <= 3) deadlineScore = 0.9;
    else if (daysUntil <= 7) deadlineScore = 0.75;
    else if (daysUntil <= 30) deadlineScore = 0.4;
    else deadlineScore = 0.15;
  }

  // Phase 3: downstreamPRCount not available
  const downstreamPRScore = 0.0;

  const score = taskBlockScore * 0.6 + deadlineScore * 0.4;

  return {
    score: Math.round(score * 1000) / 1000,
    taskBlockScore: Math.round(taskBlockScore * 1000) / 1000,
    deadlineScore,
    downstreamPRScore,
  };
}

// ── Composite score ───────────────────────────────────────────────────────────

/**
 * Compute the Stage B composite score [0,1] from the four rubric scores.
 *
 * Weights chosen to reflect the RFC's ordering of importance (load-bearing
 * is the primary signal; cost-of-block is secondary; actor-fit and
 * llm-confidence are supporting):
 *
 *   loadBearing    35%
 *   costOfBlock    30%
 *   actorFit       20%
 *   llmConfidence  15%
 */
export function computeStageBCompositeScore(rubric: StageBRubricScores): number {
  const score =
    rubric.loadBearing.score * 0.35 +
    rubric.costOfBlock.score * 0.3 +
    rubric.actorFit.score * 0.2 +
    rubric.llmConfidence.score * 0.15;
  return Math.round(score * 1000) / 1000;
}

// ── Actor routing (§6.2) ─────────────────────────────────────────────────────

/**
 * Route the decision to an actor based on Stage A output + Stage B rubric
 * scores, following §6.2 rules:
 *
 * ```
 * LLM-eligible (reversible + high llm-confidence + low blast-radius)
 *   → 'framework' (auto-decide; digest-visible)
 * multi-pillar
 *   → 'operator' + subActors = configured pillar owners (AC#3)
 * single-pillar with configured owner
 *   → owner email
 * single-pillar without configured owner  /  load-bearing + ambiguous
 *   → 'operator' (escalation)
 * ```
 *
 * AC#4 — never auto-fills all three: `subActors` only contains pillar owners
 * that are EXPLICITLY configured in `pillarOwners`. Missing entries are dropped
 * rather than replaced with a placeholder.
 */
export function routeDecisionActor(
  decision: Decision,
  stageA: StageAOutput,
  rubric: StageBRubricScores,
  compositeScore: number,
  pillarOwners: PillarOwnerConfig = DEFAULT_PILLAR_OWNERS,
): StageBActorRoute {
  const { affectedPillars, blockedTaskCount } = stageA.blastRadius;
  const reversibility = stageA.reversibility;

  // Existing explicit routing from Stage A takes precedence — but only when
  // it's a resolved email / 'framework' / 'operator'. Pillar-tag actors
  // (e.g. 'pillar:engineering') are resolved here to owner emails.
  const existingActor = decision.status?.routing?.assignedActor;
  const isPillarTag = typeof existingActor === 'string' && existingActor.startsWith('pillar:');
  if (existingActor && !isPillarTag) {
    return {
      primaryActor: existingActor,
      subActors: [],
      rationale: `Routing preserved from Stage A: ${existingActor}`,
      llmEligible: stageA.blastRadius.blockedTaskCount <= STAGE_B_LLM_ELIGIBLE_MAX_TASKS,
    };
  }

  // LLM-eligibility: reversible + high confidence + low blast-radius
  const llmEligible =
    reversibility === 'reversible' &&
    rubric.llmConfidence.score >= STAGE_B_LLM_ELIGIBLE_THRESHOLD &&
    blockedTaskCount <= STAGE_B_LLM_ELIGIBLE_MAX_TASKS;

  // Framework auto-decide: LLM-eligible + high composite confidence
  if (llmEligible && compositeScore >= STAGE_B_HIGH_CONFIDENCE_THRESHOLD) {
    return {
      primaryActor: 'framework',
      subActors: [],
      rationale:
        `LLM-eligible (reversible + llmConfidence=${rubric.llmConfidence.score.toFixed(2)} ≥ ${STAGE_B_LLM_ELIGIBLE_THRESHOLD}) ` +
        `and high composite confidence (${compositeScore.toFixed(2)} ≥ ${STAGE_B_HIGH_CONFIDENCE_THRESHOLD}). ` +
        `Framework auto-decides; operator sees in digest.`,
      llmEligible: true,
    };
  }

  // Multi-pillar → operator (AC#3: add configured sub-actors per pillar)
  if (affectedPillars.length > 1) {
    // AC#4: only include pillars that have a configured owner — never fill all three
    const subActors = affectedPillars
      .map((pillar) => pillarOwners[pillar as keyof PillarOwnerConfig])
      .filter((email): email is string => typeof email === 'string');

    const operatorActor = pillarOwners.operator ?? 'operator';
    return {
      primaryActor: operatorActor,
      subActors,
      rationale:
        `Multi-pillar decision (${affectedPillars.join(', ')}) requires cross-pillar authority. ` +
        `Assigned to operator per §6.2. Sub-actors: ${subActors.length > 0 ? subActors.join(', ') : 'none configured'}.`,
      llmEligible,
    };
  }

  // Single-pillar (or pillar-tag from Stage A) → resolve to owner email
  const pillar =
    affectedPillars.length === 1
      ? affectedPillars[0]
      : isPillarTag
        ? (existingActor as string).replace('pillar:', '')
        : null;

  if (pillar) {
    const ownerEmail = pillarOwners[pillar as keyof PillarOwnerConfig];
    if (ownerEmail) {
      return {
        primaryActor: ownerEmail,
        subActors: [],
        rationale: `Single-pillar decision (${pillar}) routed to configured owner: ${ownerEmail}.`,
        llmEligible,
      };
    }
    // Pillar not configured → escalate to operator
    return {
      primaryActor: pillarOwners.operator ?? 'operator',
      subActors: [],
      rationale:
        `Single-pillar decision (${pillar}) but no owner configured for this pillar. ` +
        `Escalating to operator.`,
      llmEligible,
    };
  }

  // Load-bearing + ambiguous (no clear pillar) → operator with escalation note
  if (rubric.loadBearing.score >= 0.7) {
    return {
      primaryActor: pillarOwners.operator ?? 'operator',
      subActors: [],
      rationale:
        `High load-bearing-ness (${rubric.loadBearing.score.toFixed(2)}) with ambiguous pillar. ` +
        `Escalating to operator per §6.2 load-bearing + ambiguous rule.`,
      llmEligible,
    };
  }

  // Default: operator
  return {
    primaryActor: pillarOwners.operator ?? 'operator',
    subActors: [],
    rationale: `Default routing to operator (no unambiguous pillar match).`,
    llmEligible,
  };
}

// ── Stage B input ─────────────────────────────────────────────────────────────

export interface StageBInput {
  /** The decision being evaluated. */
  decision: Decision;
  /** Stage A output (required — Stage B composes on top of Stage A). */
  stageA: StageAOutput;
  /** Pillar owner configuration. Defaults to empty (no auto-fills — AC#4). */
  pillarOwners?: PillarOwnerConfig;
  /** Optional current timestamp (tests). */
  now?: Date;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run Stage B rubric scoring on a decision that Stage A has already evaluated.
 *
 * Returns a `StageBOutput` with:
 * - All four rubric scores (3/4 deterministic; 2 sub-dims are Phase 5 LLM)
 * - Actor routing: primary actor + sub-actors (AC#2, AC#3)
 * - Composite confidence score [0,1]
 * - `resolvedByStageB` flag (true when outside the mid-band LLM-trigger zone)
 *
 * AC#5 — No LLM calls: all scoring is synchronous and deterministic.
 *
 * The caller is responsible for storing the result via
 * `makeStageBRecommendationIssuedEvent` + `appendDecisionEvent` (AC#6).
 */
export function runStageB(input: StageBInput): StageBOutput {
  const { decision, stageA, pillarOwners = DEFAULT_PILLAR_OWNERS } = input;

  // ── Rubric scores ──────────────────────────────────────────────────────────

  const loadBearing = scoreLoadBearing(
    stageA.reversibility,
    stageA.blastRadius.blockedTaskCount,
    stageA.decisionTreeDepth,
    decision.status?.deadline ?? null,
  );

  const llmConfidence = scoreLlmConfidence(decision);

  const actorFit = scoreActorFit(stageA.blastRadius.affectedPillars, stageA.capacityCheck);

  const costOfBlock = scoreCostOfBlock(
    stageA.blastRadius.blockedTaskCount,
    decision.status?.capacity?.tier,
    decision.status?.deadline ?? null,
  );

  const rubricScores: StageBRubricScores = {
    loadBearing,
    llmConfidence,
    actorFit,
    costOfBlock,
  };

  // ── Composite score ────────────────────────────────────────────────────────

  const compositeScore = computeStageBCompositeScore(rubricScores);

  // ── Actor routing ──────────────────────────────────────────────────────────

  const routing = routeDecisionActor(decision, stageA, rubricScores, compositeScore, pillarOwners);

  // ── resolvedByStageB ───────────────────────────────────────────────────────

  // Per §5.3: Stage C fires only when Stage B leaves a confidence gap in the
  // mid-band [0.4, 0.7]. Stage B resolves when outside this band.
  const resolvedByStageB =
    compositeScore >= STAGE_B_HIGH_CONFIDENCE_THRESHOLD ||
    compositeScore < STAGE_B_LOW_CONFIDENCE_THRESHOLD;

  return {
    rubricScores,
    routing,
    compositeScore,
    resolvedByStageB,
  };
}

// ── Event factory ─────────────────────────────────────────────────────────────

export interface MakeStageBRecommendationIssuedEventInput {
  decisionId: string;
  stageAOutput: StageAOutput;
  stageBOutput: StageBOutput;
  by?: string;
  now?: Date;
}

/**
 * Build a `recommendation-issued` event carrying both Stage A and Stage B
 * output. The caller passes this to `appendDecisionEvent` to persist the
 * result (AC#6 — routing rationale stored on Decision record).
 *
 * The projection folds this event into:
 *   `status.evaluation.stageA`   — Stage A signal breakdown
 *   `status.evaluation.stageB`   — Stage B rubric scores + routing
 *   `status.routing`             — actorRationale, assignedActor, subActors, llmEligible
 *   `status.priority`            — composite priority signal
 */
export function makeStageBRecommendationIssuedEvent(
  input: MakeStageBRecommendationIssuedEventInput,
): RecommendationIssuedEvent {
  const ts = (input.now ?? new Date()).toISOString();

  const routing: DecisionRouting = {
    assignedActor: input.stageBOutput.routing.primaryActor,
    actorRationale: input.stageBOutput.routing.rationale,
    llmEligible: input.stageBOutput.routing.llmEligible,
    subActors: input.stageBOutput.routing.subActors,
  };

  const evt: RecommendationIssuedEvent = {
    eventVersion: 'v1' as const,
    type: 'recommendation-issued' as const,
    ts,
    decisionId: input.decisionId,
    stageA: input.stageAOutput,
    stageB: input.stageBOutput,
    prioritySignal: input.stageAOutput.prioritySignal,
    routing,
    resolvedByStageA: input.stageAOutput.resolvedByStageA,
    resolvedByStageB: input.stageBOutput.resolvedByStageB,
  };

  if (input.by !== undefined) evt.by = input.by;
  return evt;
}
