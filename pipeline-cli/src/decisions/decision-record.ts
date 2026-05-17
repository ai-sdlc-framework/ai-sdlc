/**
 * RFC-0035 Decision resource types + event types.
 *
 * The Decision Catalog is event-sourced (OQ-1 resolution): an append-only
 * event log at `.ai-sdlc/_decisions/events.jsonl` is the source of truth,
 * and a `Decision` is the materialized projection over events that share
 * the same `decisionId`.
 *
 * Schema source of truth: `spec/schemas/decision.v1.schema.json`.
 *
 * @module decisions/decision-record
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const DECISION_SOURCES = [
  'dor-clarification',
  'rfc-open-question',
  'emergent-finding',
  'framework-calibration',
  'subagent-escalation',
  'ad-hoc',
] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];

export const DECISION_LIFECYCLES = [
  'proposed',
  'open',
  'deferred',
  'answered',
  'superseded',
  'archived',
] as const;
export type DecisionLifecycle = (typeof DECISION_LIFECYCLES)[number];

/**
 * OQ-1 resolution — initial event types for the v1 catalog. Schema evolution
 * is additive only (new types appended); removing or changing semantics
 * requires a spec rev.
 */
export const DECISION_EVENT_TYPES = [
  'decision-opened',
  'recommendation-issued',
  'operator-answered',
  'timebox-fired',
  'overridden',
  'calibration-adjusted',
  'superseded',
  'deferred',
  'archived',
  'dedup-merged',
  'routing-changed',
] as const;
export type DecisionEventType = (typeof DECISION_EVENT_TYPES)[number];

export const DECISION_TIERS = ['xs', 's', 'm', 'l', 'xl'] as const;
export type DecisionTier = (typeof DECISION_TIERS)[number];

// ── Decision option (the choices the operator picks from) ────────────────────

export interface DecisionOption {
  /** Slug — e.g. 'opt-a'. */
  id: string;
  description: string;
  /** Bulleted consequences if this option is chosen. */
  consequences?: string[];
  /** Downstream artifacts that depend on this option (issues, RFCs). */
  dependents?: string[];
  /** Follow-up decisions implied by choosing this option. */
  subDecisions?: string[];
}

// ── Decision (projected state) ───────────────────────────────────────────────

export interface DecisionMetadata {
  /** DEC-NNNN — globally unique within the catalog. */
  id: string;
  source: DecisionSource;
  /** Free-form scope reference: 'rfc:RFC-0035', 'issue:AISDLC-285', 'workspace', etc. */
  scope: string;
  /** ISO-8601 UTC timestamp of the `decision-opened` event. */
  created: string;
  /** ISO-8601 UTC timestamp of the most recent event. */
  updated: string;
}

export interface DecisionSpec {
  summary: string;
  body?: string;
  /** OQ-3/OQ-12 — auto-apply + override window gate. Default true. */
  reversible?: boolean;
  options: DecisionOption[];
  /** DEC-NNNN ids that gate this decision. */
  dependsOn?: string[];
}

export interface DecisionRouting {
  assignedActor?: string | null;
  actorRationale?: string | null;
  llmEligible?: boolean;
  /**
   * For multi-pillar decisions: email addresses of all involved pillar owners
   * (Stage B — AC#3). Empty or absent for single-actor routing.
   */
  subActors?: string[];
}

export interface DecisionCapacity {
  tier?: DecisionTier;
}

export interface DecisionStatus {
  lifecycle: DecisionLifecycle;
  answeredOptionId?: string | null;
  answeredBy?: string | null;
  answeredAt?: string | null;
  supersededBy?: string | null;
  routing?: DecisionRouting;
  /** Stage A/B/C scoring output — schema-loose at Phase 1. */
  evaluation?: Record<string, unknown>;
  priority?: number | null;
  capacity?: DecisionCapacity;
  deadline?: string | null;
}

/**
 * Materialized Decision view — the schema described by
 * `spec/schemas/decision.v1.schema.json`. Produced by projecting events
 * with a matching `decisionId` from the append-only log.
 */
export interface Decision {
  apiVersion: 'ai-sdlc.io/v1alpha1';
  kind: 'Decision';
  metadata: DecisionMetadata;
  spec: DecisionSpec;
  status: DecisionStatus;
  /** Full event history (oldest → newest), included in `show` output. */
  decisionLog: DecisionEvent[];
}

// ── Decision events (the append-only log entries) ────────────────────────────

/**
 * The shared envelope every event carries. Per-type fields are added by
 * the event factories below — the union type captures only the discriminator
 * + envelope shape because Phase 1 only writes `decision-opened` events;
 * later phases extend with type-specific payloads.
 */
export interface DecisionEventEnvelope {
  /** Always 'v1' for this schema. */
  eventVersion: 'v1';
  type: DecisionEventType;
  /** ISO-8601 UTC timestamp at append time. */
  ts: string;
  /** DEC-NNNN — the decision this event applies to. */
  decisionId: string;
  /** Actor (operator email, agent role, 'framework'). */
  by?: string;
}

/**
 * The `decision-opened` event carries the full initial Decision spec —
 * subsequent events only carry deltas. This makes `decision-opened` the
 * minimal event needed to materialize a Decision (Phase 1 ships only this
 * type via `cli-decisions add`).
 */
export interface DecisionOpenedEvent extends DecisionEventEnvelope {
  type: 'decision-opened';
  source: DecisionSource;
  scope: string;
  summary: string;
  body?: string;
  reversible?: boolean;
  options: DecisionOption[];
  dependsOn?: string[];
  /** Optional initial routing assignment captured at open time. */
  routing?: DecisionRouting;
  /** Optional initial capacity tier (RFC-0016 t-shirt size). */
  capacity?: DecisionCapacity;
  /** Optional initial deadline. */
  deadline?: string | null;
}

/**
 * RFC-0035 Phase 4 — `operator-answered` event.
 *
 * Emitted when an operator (or the framework, per Stage A/B/C auto-decision)
 * resolves a Decision by picking one of its declared options. The projection
 * folds this event into `status.lifecycle = 'answered'`.
 */
export interface OperatorAnsweredEvent extends DecisionEventEnvelope {
  type: 'operator-answered';
  /** The `id` field of the chosen `DecisionOption`. */
  chosenOptionId: string;
  /** Optional free-text rationale for the choice. */
  rationale?: string;
}

/**
 * Discriminated union of every event the projection knows how to fold.
 * Phase 1 only emits `DecisionOpenedEvent`; Phase 2 adds `RecommendationIssuedEvent`;
 * Phase 4 adds `OperatorAnsweredEvent`. The projection tolerates unknown event
 * types so the reader stays forward-compatible when a later phase adds a new type.
 */
export type DecisionEvent =
  | DecisionOpenedEvent
  | RecommendationIssuedEvent
  | OperatorAnsweredEvent
  | (DecisionEventEnvelope & {
      type: Exclude<
        DecisionEventType,
        'decision-opened' | 'recommendation-issued' | 'operator-answered'
      >;
    } & Record<string, unknown>);

// ── Stage A output types (Phase 2) ──────────────────────────────────────────

/**
 * RFC-0035 §5.1 blast-radius from RFC-0014 dep-graph traversal.
 */
export interface StageABlastRadius {
  /** Open tasks whose dep-on list includes this decision (or scope-referenced task). */
  blockedTaskCount: number;
  /** RFCs with open questions that this decision's scope references. */
  blockedRfcCount: number;
  /** Engineering / product / design pillars affected. */
  affectedPillars: string[];
}

/**
 * Duplicate-detection result (Levenshtein + normalized-summary).
 */
export interface StageADuplicateCheck {
  isDuplicate: boolean;
  /** DEC-NNNN of the candidate, or null when unique. */
  candidateId: string | null;
  /** Normalised similarity score [0,1] — 1 = identical. */
  similarity: number;
}

/**
 * Per-decision Stage A signal breakdown stored on the Decision record
 * (AC#4 — stored in `status.evaluation.stageA`).
 */
export interface StageAOutput {
  /** 1. Schema validity — JSON-schema + structural checks. */
  schemaValidity: { valid: boolean; reasons: string[] };
  /** 2. Blast-radius from RFC-0014 dep-graph (AC#2). */
  blastRadius: StageABlastRadius;
  /** 3. Reference resolution — scope + dependsOn refs resolved against graph. */
  referenceResolution: { resolved: boolean; broken: string[] };
  /** 4. Decision-tree depth — max depth of declared subDecisions[]. */
  decisionTreeDepth: number;
  /** 5. Capacity arithmetic — proposed actor vs remaining daily budget. */
  capacityCheck: { withinBudget: boolean; reason: string };
  /** 6. Reversibility — pattern-match against irreversible categories. */
  reversibility: 'reversible' | 'one-way' | 'unknown';
  /** 7. Duplicate detection — Levenshtein against open decisions. */
  duplicateDetection: StageADuplicateCheck;
  /** Composite priority signal [0,1]. Higher = more urgent. */
  prioritySignal: number;
  /**
   * AC#3 — true when all inputs are deterministic and no Stage B/C LLM call
   * is needed to determine routing and priority.
   */
  resolvedByStageA: boolean;
  /**
   * Actor determined unambiguously by Stage A alone, or null when Stage B/C
   * is needed to resolve routing.
   */
  routingActor: string | null;
}

// ── Stage B output types (Phase 3) ──────────────────────────────────────────

/**
 * RFC-0035 §5.2 — Load-bearing-ness rubric sub-scores.
 * 3/4 deterministic in Phase 3; reversibility may need LLM for novel
 * categories (Phase 5 will fill the fourth dimension via Haiku-class call).
 */
export interface StageBLoadBearingScore {
  /** Composite load-bearing-ness score [0,1]. */
  score: number;
  /** Reversibility sub-score: one-way=1.0, unknown=0.5, reversible=0.0. */
  reversibility: number;
  /** Blast-radius sub-score (log-diminishing per OQ-2). */
  blastRadius: number;
  /** Downstream-decision count sub-score (decision tree depth). */
  downstreamDecisions: number;
  /** Deadline-criticality sub-score: overdue=1.0, no deadline=0.0. */
  deadlineCriticality: number;
}

/**
 * RFC-0035 §5.2 — LLM-confidence rubric sub-scores.
 * Phase 3 implements 2/4 deterministic dimensions; novelty and
 * exemplar-similarity default to 0.5 (conservative placeholder) until
 * Phase 5 adds the Haiku-class LLM calls.
 */
export interface StageBLlmConfidenceScore {
  /** Composite LLM-confidence score [0,1]. */
  score: number;
  /** Whether the decision body references an RFC-stated position. */
  rfcStatedPositionPresence: number;
  /** Completeness of the decision's evidence (body + option consequences). */
  evidenceCompleteness: number;
  /** Novelty score — 0.5 (placeholder) until Phase 5. */
  novelty: number;
  /** Exemplar-similarity score — 0.5 (placeholder) until Phase 5. */
  exemplarSimilarity: number;
}

/**
 * RFC-0035 §5.2 — Actor-fit rubric sub-scores.
 * Fully deterministic given RFC-0029 pillar tagging.
 * Override-history and expertise-tag are 0.5 placeholders until Phase 9.
 */
export interface StageBActorFitScore {
  /** Composite actor-fit score [0,1]. */
  score: number;
  /** Single-pillar=1.0, multi-pillar=0.5, no-pillars=0.0. */
  declaredPillarMatch: number;
  /** Within budget=1.0, over budget=0.0. */
  capacityAvailability: number;
  /** Override-history fit — 0.5 until Phase 9 (no history). */
  overrideHistoryFit: number;
  /** Expertise-tag match — 0.5 until Phase 9 (no tag data). */
  expertiseTagMatch: number;
}

/**
 * RFC-0035 §5.2 — Cost-of-block rubric sub-scores.
 * Fully deterministic from dep-graph + deadline + tier.
 * Downstream-PR count is 0.0 in Phase 3 (no PR data).
 */
export interface StageBCostOfBlockScore {
  /** Composite cost-of-block score [0,1]. */
  score: number;
  /** blockedTaskCount × tier-weight, log-normalised. */
  taskBlockScore: number;
  /** Deadline distance score: overdue=1.0, no deadline=0.0. */
  deadlineScore: number;
  /** Downstream-PR count score — 0.0 until Phase 8 (no PR data). */
  downstreamPRScore: number;
}

/**
 * RFC-0035 §5.2 — Stage B rubric scores (four dimensions each [0,1]).
 */
export interface StageBRubricScores {
  loadBearing: StageBLoadBearingScore;
  llmConfidence: StageBLlmConfidenceScore;
  actorFit: StageBActorFitScore;
  costOfBlock: StageBCostOfBlockScore;
}

/**
 * RFC-0035 §6.2 — Actor routing result from Stage B.
 *
 * AC#2: single primary actor + sub-actor list.
 * AC#3: multi-pillar decisions populate `subActors` with each pillar's owner.
 * AC#4: `subActors` only contains CONFIGURED owners (never auto-fills all three).
 */
export interface StageBActorRoute {
  /**
   * Primary actor: email / 'framework' / 'operator' / 'pillar:<name>'.
   * 'framework' = auto-decide; 'operator' = escalate to cross-pillar owner.
   */
  primaryActor: string;
  /**
   * For multi-pillar decisions: email addresses of all involved pillar owners.
   * Empty when routing is single-actor. Never contains actors not in the
   * PillarOwnerConfig (AC#4 — never auto-fills missing entries).
   */
  subActors: string[];
  /**
   * Human-readable rationale for this routing decision (AC#6 — stored on
   * Decision record via projection into `status.routing.actorRationale`).
   */
  rationale: string;
  /** Whether the decision is LLM-auto-resolve eligible (Stage A+B assessment). */
  llmEligible: boolean;
}

/**
 * RFC-0035 Phase 3 — Stage B output.
 *
 * Produced by `runStageB()` in `stage-b.ts`. Stored on the Decision record
 * via a `recommendation-issued` event (AC#6 — `routing.rationale` projected
 * into `status.routing.actorRationale`).
 */
export interface StageBOutput {
  rubricScores: StageBRubricScores;
  routing: StageBActorRoute;
  /** Composite confidence score [0,1] — weighted average of the 4 rubric scores. */
  compositeScore: number;
  /**
   * Whether Stage B was able to determine routing without Stage C LLM.
   * Per §5.3: Stage C fires when compositeScore is in the mid-band [0.4, 0.7].
   * True when compositeScore >= 0.7 (high confidence) or < 0.4 (low confidence).
   */
  resolvedByStageB: boolean;
}

// ── recommendation-issued event (Phase 2+3) ──────────────────────────────────

/**
 * Emitted when Stage A (and optionally Stage B/C) produces a recommendation.
 * Phase 2 ships the Stage A portion; Phase 3 adds the optional `stageB` field.
 * Stored on the Decision record via the projection (AC#4).
 */
export interface RecommendationIssuedEvent extends DecisionEventEnvelope {
  type: 'recommendation-issued';
  /** Stage A output — always present for Phase 2+ events. */
  stageA: StageAOutput;
  /** Stage B output — present when Phase 3 rubric scoring has run. */
  stageB?: StageBOutput;
  /** Composite priority signal carried here for quick access in the projection. */
  prioritySignal: number;
  /** Routing recommendation from Stage A or Stage B. */
  routing?: DecisionRouting;
  /** AC#3 — whether Stage A resolved routing without Stage B/C. */
  resolvedByStageA: boolean;
  /** Whether Stage B resolved routing without Stage C LLM. */
  resolvedByStageB?: boolean;
}

// ── Validators ───────────────────────────────────────────────────────────────

const ID_PATTERN = /^DEC-[0-9]{4,}$/;
const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidDecisionId(id: string): boolean {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * Structural validation for a raw decision-event line read from the log.
 * Returns an error message on the first violation, or null when valid.
 * Tolerates unknown additional fields (forward-compat).
 */
export function validateDecisionEvent(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const r = raw as Record<string, unknown>;

  if (r.eventVersion !== 'v1') return 'eventVersion: must be "v1"';
  if (typeof r.type !== 'string' || !DECISION_EVENT_TYPES.includes(r.type as DecisionEventType)) {
    return `type: must be one of ${DECISION_EVENT_TYPES.join('|')}`;
  }
  if (typeof r.ts !== 'string' || r.ts.length === 0) return 'ts: missing or empty';
  if (typeof r.decisionId !== 'string' || !ID_PATTERN.test(r.decisionId)) {
    return 'decisionId: must match DEC-NNNN';
  }

  if (r.type === 'decision-opened') {
    if (typeof r.summary !== 'string' || r.summary.length === 0) {
      return 'decision-opened: summary is required';
    }
    if (typeof r.source !== 'string' || !DECISION_SOURCES.includes(r.source as DecisionSource)) {
      return `decision-opened: source must be one of ${DECISION_SOURCES.join('|')}`;
    }
    if (typeof r.scope !== 'string' || r.scope.length === 0) {
      return 'decision-opened: scope is required';
    }
    if (!Array.isArray(r.options) || r.options.length === 0) {
      return 'decision-opened: options must be a non-empty array';
    }
    for (const opt of r.options as unknown[]) {
      if (!opt || typeof opt !== 'object') return 'decision-opened: option not an object';
      const o = opt as Record<string, unknown>;
      if (typeof o.id !== 'string' || !OPTION_ID_PATTERN.test(o.id)) {
        return `decision-opened: option id must match ${OPTION_ID_PATTERN}`;
      }
      if (typeof o.description !== 'string' || o.description.length === 0) {
        return 'decision-opened: option description is required';
      }
    }
  }

  return null;
}

// ── ID generation ────────────────────────────────────────────────────────────

/**
 * Format a numeric counter as a DEC-NNNN id with 4-digit zero padding (the
 * suffix grows beyond 4 digits naturally for catalogs > 9999 decisions).
 */
export function formatDecisionId(counter: number): string {
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error(`[decisions] invalid id counter: ${counter}`);
  }
  return `DEC-${counter.toString().padStart(4, '0')}`;
}
