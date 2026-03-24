/**
 * Product Priority Algorithm (PPA) — composite scoring module.
 *
 * Implements the PPA priority function:
 *   P(w) = Sα(w) × Dπ(w) × Mφ(w) × Eρ(w) × (1 − Eτ) × (1 + HC(w)) × Cκ(w)
 *
 * Each dimension maps real-world product signals into a bounded numeric
 * range and the multiplicative composite lets any single zero-score
 * dimension veto the work item.
 *
 * RFC reference: PPA section (priority scoring).
 */

// ── Types ───────────────────────────────────────────────────────────

export interface PriorityScore {
  composite: number;
  dimensions: {
    soulAlignment: number; // Sα  [0, 1]
    demandPressure: number; // Dπ  [0, 1.5]
    marketForce: number; // Mφ  [0.5, 3.0] (bounded, not [0.025, 45])
    executionReality: number; // Eρ  [0, 1]
    entropyTax: number; // Eτ  [0, 1]
    humanCurve: number; // HC  [-1, 1]
    calibration: number; // Cκ  [0.7, 1.3]
  };
  confidence: number; // [0, 1]
  timestamp: string;
  /** Present when the score was produced via override. */
  override?: { reason: string; expiry?: string };
}

export interface PriorityInput {
  /** Work item identifier */
  itemId: string;
  /** Work item title and description for semantic analysis */
  title: string;
  description: string;
  /** Labels/tags on the work item */
  labels?: string[];

  // Soul Alignment inputs
  /** Pre-computed soul alignment score, or undefined to skip */
  soulAlignment?: number;

  // Demand Pressure inputs
  /** Number of customer requests for this feature */
  customerRequestCount?: number;
  /** Recency-weighted demand signal [0, 1] */
  demandSignal?: number;
  /** Bug severity if this is a bug (1-5, 5=critical) */
  bugSeverity?: number;
  /** Builder conviction / roadmap priority [0, 1] */
  builderConviction?: number;

  // Market Force inputs
  /** Technology inflection relevance [0, 1] */
  techInflection?: number;
  /** Competitive pressure relevance [0, 1] */
  competitivePressure?: number;
  /** Regulatory urgency [0, 1] */
  regulatoryUrgency?: number;

  // Execution Reality inputs (from AI-SDLC)
  /** Task complexity from parseComplexity() (1-10) */
  complexity?: number;
  /** Budget utilization percent from CostTracker */
  budgetUtilization?: number;
  /** Are dependencies clear? [0, 1] */
  dependencyClearance?: number;

  // Entropy Tax inputs
  /** Competitive drift score [0, 1] */
  competitiveDrift?: number;
  /** Market divergence [0, 1] */
  marketDivergence?: number;

  // Human Curve inputs
  /** Explicit priority from backlog tool [0, 1] */
  explicitPriority?: number;
  /** Team consensus signal (votes, watchers) [0, 1] */
  teamConsensus?: number;
  /** Meeting decision weight [0, 1] */
  meetingDecision?: number;
  /** Override flag — if true, bypasses algorithm */
  override?: boolean;
  /** Override reason (required when override=true) */
  overrideReason?: string;
  /** Override expiry ISO timestamp */
  overrideExpiry?: string;
}

export interface PriorityConfig {
  /** Weights for human curve sub-components */
  humanCurveWeights?: { explicit?: number; consensus?: number; decision?: number };
  /** Calibration coefficient (default 1.0) */
  calibrationCoefficient?: number;
}

// ── Constants ───────────────────────────────────────────────────────

/** Default value used when an input signal is not provided. */
const DEFAULT_SIGNAL = 0.5;

/** Market force bounds — tighter than the paper's [0.025, 45]. */
const MARKET_FORCE_MIN = 0.5;
const MARKET_FORCE_MAX = 3.0;

/** Calibration coefficient bounds. */
const CALIBRATION_MIN = 0.7;
const CALIBRATION_MAX = 1.3;

/** Default weights for human curve sub-components. */
const DEFAULT_HC_WEIGHTS = { explicit: 0.5, consensus: 0.3, decision: 0.2 };

/**
 * Total number of optional input fields that contribute to confidence.
 * When all are provided confidence = 1; when none are provided confidence
 * equals the ratio of zero provided over this count.
 */
const SCORABLE_FIELDS: ReadonlyArray<keyof PriorityInput> = [
  'soulAlignment',
  'customerRequestCount',
  'demandSignal',
  'bugSeverity',
  'builderConviction',
  'techInflection',
  'competitivePressure',
  'regulatoryUrgency',
  'complexity',
  'budgetUtilization',
  'dependencyClearance',
  'competitiveDrift',
  'marketDivergence',
  'explicitPriority',
  'teamConsensus',
  'meetingDecision',
];

// ── Helpers ─────────────────────────────────────────────────────────

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Dimension Computations ──────────────────────────────────────────

/**
 * Sα — Soul Alignment [0, 1].
 * How well the work item aligns with the product's core mission.
 */
function computeSoulAlignment(input: PriorityInput): number {
  return clamp(input.soulAlignment ?? DEFAULT_SIGNAL, 0, 1);
}

/**
 * Dπ — Demand Pressure [0, 1.5].
 * Blends customer requests, recency-weighted demand, bug severity, and
 * builder conviction into a single demand signal.
 */
function computeDemandPressure(input: PriorityInput): number {
  const requestSignal =
    input.customerRequestCount !== undefined
      ? Math.min(1, input.customerRequestCount / 10)
      : DEFAULT_SIGNAL;

  const demandSignal = input.demandSignal ?? DEFAULT_SIGNAL;

  const severitySignal = input.bugSeverity !== undefined ? input.bugSeverity / 5 : 0; // no bug severity means no bug boost

  const conviction = input.builderConviction ?? DEFAULT_SIGNAL;

  // Weighted blend, scaled to [0, 1.5]
  const raw = requestSignal * 0.3 + demandSignal * 0.3 + severitySignal * 0.2 + conviction * 0.2;
  return clamp(raw * 1.5, 0, 1.5);
}

/**
 * Mφ — Market Force [0.5, 3.0].
 * Captures technology inflection, competitive pressure, and regulatory
 * urgency as a multiplicative amplifier.
 */
function computeMarketForce(input: PriorityInput): number {
  const tech = input.techInflection ?? DEFAULT_SIGNAL;
  const competitive = input.competitivePressure ?? DEFAULT_SIGNAL;
  const regulatory = input.regulatoryUrgency ?? DEFAULT_SIGNAL;

  // Average of the three signals, scaled to the bounded range
  const avg = (tech + competitive + regulatory) / 3;
  const scaled = MARKET_FORCE_MIN + avg * (MARKET_FORCE_MAX - MARKET_FORCE_MIN);
  return clamp(scaled, MARKET_FORCE_MIN, MARKET_FORCE_MAX);
}

/**
 * Eρ — Execution Reality [0, 1].
 * Factors in complexity (inverse), budget headroom, and dependency
 * clearance to express how feasible execution is right now.
 */
function computeExecutionReality(input: PriorityInput): number {
  // Complexity 1-10 → inverse feasibility (1 = easy, 10 = very hard)
  const complexityFeasibility =
    input.complexity !== undefined ? 1 - (input.complexity - 1) / 9 : DEFAULT_SIGNAL;

  // Budget utilization: higher usage → less headroom → lower score
  const budgetHeadroom =
    input.budgetUtilization !== undefined
      ? 1 - clamp(input.budgetUtilization / 100, 0, 1)
      : DEFAULT_SIGNAL;

  const depClearance = input.dependencyClearance ?? DEFAULT_SIGNAL;

  const raw = complexityFeasibility * 0.4 + budgetHeadroom * 0.3 + depClearance * 0.3;
  return clamp(raw, 0, 1);
}

/**
 * Eτ — Entropy Tax [0, 1].
 * Captures competitive drift and market divergence. Higher entropy means
 * the work item is becoming less relevant over time.
 */
function computeEntropyTax(input: PriorityInput): number {
  const drift = input.competitiveDrift ?? 0; // default: no drift
  const divergence = input.marketDivergence ?? 0; // default: no divergence
  const raw = (drift + divergence) / 2;
  return clamp(raw, 0, 1);
}

/**
 * HC — Human Curve [-1, 1].
 * Blends explicit priority, team consensus, and meeting decisions through
 * tanh to produce a bounded human signal.
 */
function computeHumanCurve(
  input: PriorityInput,
  weights: { explicit: number; consensus: number; decision: number },
): number {
  const explicit = input.explicitPriority ?? DEFAULT_SIGNAL;
  const consensus = input.teamConsensus ?? DEFAULT_SIGNAL;
  const decision = input.meetingDecision ?? DEFAULT_SIGNAL;

  // Center around 0.5 so default inputs produce ~0 HC
  const centered =
    (explicit - 0.5) * weights.explicit +
    (consensus - 0.5) * weights.consensus +
    (decision - 0.5) * weights.decision;

  // Scale up so full-range inputs can reach [-1, 1] through tanh
  return Math.tanh(centered * 2);
}

/**
 * Cκ — Calibration Coefficient [0.7, 1.3].
 * A tuning knob that lets operators scale the final score up or down.
 */
function computeCalibration(config?: PriorityConfig): number {
  const coeff = config?.calibrationCoefficient ?? 1.0;
  return clamp(coeff, CALIBRATION_MIN, CALIBRATION_MAX);
}

// ── Confidence ──────────────────────────────────────────────────────

/**
 * Compute a confidence score [0, 1] based on the fraction of optional
 * input fields that were explicitly provided (not defaulted).
 */
function computeConfidence(input: PriorityInput): number {
  let provided = 0;
  for (const field of SCORABLE_FIELDS) {
    if (input[field] !== undefined) {
      provided++;
    }
  }
  return provided / SCORABLE_FIELDS.length;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Compute the PPA composite priority score for a single work item.
 *
 * P(w) = Sα × Dπ × Mφ × Eρ × (1 − Eτ) × (1 + HC) × Cκ
 */
export function computePriority(input: PriorityInput, config?: PriorityConfig): PriorityScore {
  const timestamp = new Date().toISOString();

  // ── Override path ──────────────────────────────────────────────
  if (input.override) {
    return {
      composite: Infinity,
      dimensions: {
        soulAlignment: 1,
        demandPressure: 1.5,
        marketForce: MARKET_FORCE_MAX,
        executionReality: 1,
        entropyTax: 0,
        humanCurve: 1,
        calibration: 1,
      },
      confidence: 1,
      timestamp,
      override: {
        reason: input.overrideReason ?? 'No reason provided',
        expiry: input.overrideExpiry,
      },
    };
  }

  // ── Resolve HC weights ─────────────────────────────────────────
  const hcWeights = {
    explicit: config?.humanCurveWeights?.explicit ?? DEFAULT_HC_WEIGHTS.explicit,
    consensus: config?.humanCurveWeights?.consensus ?? DEFAULT_HC_WEIGHTS.consensus,
    decision: config?.humanCurveWeights?.decision ?? DEFAULT_HC_WEIGHTS.decision,
  };

  // ── Compute each dimension ────────────────────────────────────
  const soulAlignment = computeSoulAlignment(input);
  const demandPressure = computeDemandPressure(input);
  const marketForce = computeMarketForce(input);
  const executionReality = computeExecutionReality(input);
  const entropyTax = computeEntropyTax(input);
  const humanCurve = computeHumanCurve(input, hcWeights);
  const calibration = computeCalibration(config);

  // ── Composite ─────────────────────────────────────────────────
  const composite =
    soulAlignment *
    demandPressure *
    marketForce *
    executionReality *
    (1 - entropyTax) *
    (1 + humanCurve) *
    calibration;

  return {
    composite,
    dimensions: {
      soulAlignment,
      demandPressure,
      marketForce,
      executionReality,
      entropyTax,
      humanCurve,
      calibration,
    },
    confidence: computeConfidence(input),
    timestamp,
  };
}

/**
 * Score and rank multiple work items by descending composite priority.
 * Override items (composite = Infinity) always sort first.
 */
export function rankWorkItems(
  items: PriorityInput[],
  config?: PriorityConfig,
): Array<PriorityInput & { score: PriorityScore }> {
  return items
    .map((item) => ({ ...item, score: computePriority(item, config) }))
    .sort((a, b) => b.score.composite - a.score.composite);
}
