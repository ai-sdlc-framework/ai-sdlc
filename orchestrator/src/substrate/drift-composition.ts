/**
 * RFC-0028 §7.2 — structural + statistical drift composition.
 *
 * Phase 3 of RFC-0028 §7.2 v0.2 resolution. Wires the canonical pairing of
 * the two drift-detection layers with the explicit composition rules the
 * operator resolved on 2026-05-27:
 *
 * 1. **Structural drift (CI authoring-time) REJECTS deployment.** The
 *    type-registry CI gate (`scripts/check-substrate-contract.mjs`,
 *    AISDLC-453) is the hard gate. When any of its 5 assertions fail it emits
 *    `Decision: substrate-structural-drift-detected` (severity HIGH) and
 *    blocks PR merge via a non-zero exit code. This module does NOT rebuild
 *    that gate — it *represents* its outcome so the two layers can be
 *    composed and correlated. {@link toStructuralDriftEvents} maps the gate's
 *    result into the composition model.
 *
 * 2. **Statistical drift (runtime) SURFACES to operator (RFC-0035 G0
 *    non-blocking).** PPA's `SoulDriftDetected` signal (rolling 30-day mean
 *    < 0.4 or stddev > 0.15 sustained for 3 sprints) routes to
 *    `Decision: soul-statistical-drift-detected` → operator batch review with
 *    three reconciliation paths. The pipeline NEVER halts on statistical
 *    drift. {@link evaluateStatisticalDrift} computes the signal;
 *    {@link composeDrift} routes the firing signal to the catalog request.
 *
 * 3. **Both Decisions composable in the catalog.** Both classes carry a
 *    `soulId` + a stable `driftClass` discriminant and share one catalog
 *    scope ({@link DRIFT_DECISION_SCOPE}) so an operator can query
 *    "show me all drift events for Soul X" and get structural (rejected at
 *    CI) and statistical (caught at runtime) events side-by-side —
 *    {@link correlateDriftBySoul}.
 *
 * 4. **Cold-start handling.** Statistical detection needs a rolling 30d
 *    baseline. Pre-baseline (< 30d of signal), the detector returns a
 *    `calibrating` status and emits NO statistical Decisions — structural
 *    detection is the sole defense during the calibration window. The
 *    cold-start shape mirrors RFC-0030 §13 OQ-13.5's z-score flooding
 *    detector (calibrating until the rolling window fills, then active).
 *
 * **AC-8 — no parallel event emitter.** This module does NOT import or write
 * to the catalog event log directly. Mirroring the Phase 1 `identity-class.ts`
 * audit and the Phase 2 `check-substrate-contract.mjs` gate, it produces
 * `DriftDecisionRequest` payloads (summary + scope + source + options) that
 * the *caller* forwards to the existing RFC-0035 substrate via
 * `node pipeline-cli/bin/cli-decisions.mjs add` (or `makeDecisionOpenedEvent`
 * + `appendDecisionEvent` in-process). The request shape is byte-compatible
 * with `cli-decisions add --summary … --scope … --option id:desc`. This keeps
 * the orchestrator package free of a build-time dependency on
 * `@ai-sdlc/pipeline-cli`'s dist output and avoids a second emitter.
 *
 * @see spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md §7.2
 * @see spec/rfcs/RFC-0035-decision-catalog-operator-routing.md (G0 routing)
 * @see scripts/check-substrate-contract.mjs (the structural layer, AISDLC-453)
 * @module substrate/drift-composition
 */

// ── Drift taxonomy ────────────────────────────────────────────────────────

/**
 * The two canonical drift classes per RFC-0028 §7.2. The discriminant is
 * stable so the catalog can correlate both classes for a single Soul DID.
 */
export type DriftClass = 'structural' | 'statistical';

/**
 * The RFC-0035 Decision scope used for every drift Decision. Both classes
 * share one scope so `cli-decisions list --scope substrate-drift` returns
 * the composed view (AC-3 / AC-5).
 */
export const DRIFT_DECISION_SCOPE = 'substrate-drift';

/** Decision summary slug for structural drift (matches AISDLC-453 gate). */
export const STRUCTURAL_DECISION_SLUG = 'substrate-structural-drift-detected';

/** Decision summary slug for statistical drift (RFC-0028 §7.2 rule 2). */
export const STATISTICAL_DECISION_SLUG = 'soul-statistical-drift-detected';

/**
 * Statistical-drift detection thresholds, frozen from RFC-0028 §7.2 / PPA's
 * `SoulDriftDetected` definition. A drift fires when the rolling 30-day mean
 * drops below {@link MEAN_FLOOR} OR the rolling stddev exceeds
 * {@link STDDEV_CEILING}, sustained for {@link SUSTAINED_SPRINTS} sprints.
 */
export const MEAN_FLOOR = 0.4;
export const STDDEV_CEILING = 0.15;
export const SUSTAINED_SPRINTS = 3;

/** Rolling baseline window in days (RFC-0028 §7.2 cold-start: 30d). */
export const BASELINE_WINDOW_DAYS = 30;

// ── Catalog request shape (reuses RFC-0035 substrate, AC-8) ───────────────

/**
 * One Decision-option choice the operator picks from. Mirrors the
 * RFC-0035 `DecisionOption` shape (`pipeline-cli/src/decisions/decision-record.ts`)
 * without importing it — kept structurally identical so a caller can spread
 * these directly into `makeDecisionOpenedEvent({ options })` or render them as
 * `--option <id>:<description>` flags for `cli-decisions add`.
 */
export interface DriftDecisionOption {
  id: string;
  description: string;
  consequences?: string[];
}

/**
 * A ready-to-file Decision request. The caller forwards this to the RFC-0035
 * catalog (CLI or in-process). The field names match the catalog's
 * `OpenDecisionInput` so no translation layer is needed.
 */
export interface DriftDecisionRequest {
  /** RFC-0035 Decision source. Structural=emergent-finding; statistical=framework-calibration. */
  source: 'emergent-finding' | 'framework-calibration';
  scope: string;
  summary: string;
  body?: string;
  /** Statistical drift is reversible (G0 non-blocking); structural is a hard gate. */
  reversible: boolean;
  options: DriftDecisionOption[];
}

// ── Composed drift event (the in-memory model) ────────────────────────────

/**
 * A drift event in the composition model — the side-by-side unit an operator
 * sees. Both structural and statistical events project to this shape so the
 * TUI / catalog can render them together.
 */
export interface DriftEvent {
  driftClass: DriftClass;
  /** Soul DID the drift applies to. */
  soulId: string;
  /**
   * Structural = HIGH (hard gate). Statistical = advisory (non-blocking, G0).
   */
  severity: 'high' | 'advisory';
  /** Whether this drift class blocks deployment. Structural=true always. */
  blocking: boolean;
  /** One-line operator-facing summary (used as the Decision summary). */
  summary: string;
  /** Free-form detail body for the Decision. */
  detail?: string;
}

// ── Reconciliation paths (RFC-0028 §7.2 — exactly three) ──────────────────

/**
 * The three (and only three) operator reconciliation paths for a
 * `soul-statistical-drift-detected` Decision, per RFC-0028 §7.2:
 *
 * (a) confirm drift as legitimate evolution → emit DID amendment
 * (b) confirm drift as substrate violation → file fix task
 * (c) defer for the next operator review window
 */
export const STATISTICAL_RECONCILIATION_OPTIONS: readonly DriftDecisionOption[] = Object.freeze([
  {
    id: 'confirm-as-evolution',
    description:
      'Confirm drift as legitimate evolution — emit a DID amendment to ratify the new baseline.',
    consequences: ['DID amendment authored', 'New baseline ratified as intended state'],
  },
  {
    id: 'confirm-as-violation',
    description:
      'Confirm drift as a substrate violation — file a fix task to restore the contracted baseline.',
    consequences: ['Fix task filed', 'Substrate restored to contracted intent'],
  },
  {
    id: 'defer',
    description:
      'Defer for the next operator review window — re-surface unchanged at the next batch review.',
    consequences: ['Decision re-surfaces next review window', 'No state change'],
  },
]);

/** Structural-drift reconciliation options mirror the AISDLC-453 CI gate. */
export const STRUCTURAL_RECONCILIATION_OPTIONS: readonly DriftDecisionOption[] = Object.freeze([
  { id: 'fix', description: 'Correct the contract field causing the assertion failure.' },
  { id: 'exempt', description: 'Document an RFC-approved exemption for this soul.' },
]);

// ── Structural layer: represent the CI gate outcome ───────────────────────

/**
 * The relevant subset of the structural gate's failure record
 * (`scripts/check-substrate-contract.mjs#AssertionResult`). Re-declared here
 * as a structural type so this module does not import the `.mjs` CI script
 * (which lives outside the orchestrator build graph) — callers pass the
 * gate's result through.
 */
export interface StructuralGateFailure {
  soulId: string;
  message: string;
  /** The gate's pre-formatted Decision summary, when present. */
  decisionSummary?: string;
}

export interface StructuralGateResult {
  /** True when the gate passed (no structural drift). */
  passed: boolean;
  /** True when no contracts exist (cold-start no-op). */
  coldStart: boolean;
  failures: StructuralGateFailure[];
}

/**
 * Project the structural CI gate's result into composition `DriftEvent`s.
 *
 * One `DriftEvent` per gate failure. Always `blocking: true` / severity
 * `high` — structural drift is the hard gate (RFC-0028 §7.2 rule 1). Returns
 * `[]` when the gate passed or was a cold-start no-op (no contracts).
 */
export function toStructuralDriftEvents(result: StructuralGateResult): DriftEvent[] {
  if (result.passed || result.coldStart) return [];
  return result.failures.map((f) => ({
    driftClass: 'structural' as const,
    soulId: f.soulId,
    severity: 'high' as const,
    blocking: true,
    summary: f.decisionSummary ?? `${STRUCTURAL_DECISION_SLUG}: Soul "${f.soulId}" — ${f.message}`,
    detail: f.message,
  }));
}

// ── Statistical layer: cold-start-aware detector ──────────────────────────

/**
 * A single dated drift-metric sample for one Soul DID. `value` is the PPA
 * soul-coherence metric in [0, 1]; `at` is the sample timestamp.
 */
export interface SoulDriftSample {
  /** ISO-8601 timestamp (or any Date-parseable string). */
  at: string;
  /** Coherence metric in [0, 1]; lower = more drift. */
  value: number;
}

/**
 * The detector's status. `calibrating` = pre-baseline (< 30d of signal); the
 * detector emits NO statistical Decisions in this state (cold-start, AC-4).
 * `active` = baseline accumulated; drift may fire.
 */
export type StatisticalDriftStatus = 'calibrating' | 'active';

export interface StatisticalDriftResult {
  status: StatisticalDriftStatus;
  /** True only when status is `active` AND the drift condition is met. */
  drifted: boolean;
  /** Rolling mean over the baseline window (null while calibrating). */
  rollingMean: number | null;
  /** Rolling population stddev over the window (null while calibrating). */
  rollingStdDev: number | null;
  /** Consecutive sprints the drift condition has held (active state). */
  sustainedSprints: number;
  /** Human-readable reason — used for the Decision detail when drifted. */
  reason: string;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function populationStdDev(values: number[], mu: number): number {
  const variance = values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Count the length of the trailing run of `true` values. */
function trailingTrueRun(flags: boolean[]): number {
  let run = 0;
  for (let i = flags.length - 1; i >= 0; i--) {
    if (flags[i]) run += 1;
    else break;
  }
  return run;
}

/**
 * Evaluate statistical drift for one Soul DID over its metric history.
 *
 * Cold-start (AC-4): if the span between the earliest sample and `now` is
 * shorter than {@link BASELINE_WINDOW_DAYS}, the detector is still
 * `calibrating` — it returns `drifted: false` with null statistics and the
 * caller emits no Decision. Structural detection (AISDLC-453) is the sole
 * defense during this window.
 *
 * Once the window is filled the detector is `active`: drift fires when the
 * rolling mean < {@link MEAN_FLOOR} OR the rolling stddev >
 * {@link STDDEV_CEILING}, AND that condition has held for at least
 * {@link SUSTAINED_SPRINTS} consecutive sprint buckets.
 *
 * The cold-start shape mirrors RFC-0030 §13 OQ-13.5's z-score flooding
 * detector (calibrating until the window accumulates, then active).
 *
 * @param samples Metric history (any order). Empty → calibrating.
 * @param sprintFlags Per-sprint booleans (most-recent last) indicating
 *   whether the drift condition held in each sprint; used to enforce the
 *   "3 sustained sprints" rule independent of raw sample cadence. When
 *   omitted, sustained-sprint accounting falls back to whether the current
 *   window meets the condition (counts as 1 sprint, so a single-window
 *   breach is reported but does not satisfy the 3-sprint rule).
 * @param now Clock override for deterministic tests.
 */
export function evaluateStatisticalDrift(
  samples: SoulDriftSample[],
  sprintFlags?: boolean[],
  now: Date = new Date(),
): StatisticalDriftResult {
  if (samples.length === 0) {
    return {
      status: 'calibrating',
      drifted: false,
      rollingMean: null,
      rollingStdDev: null,
      sustainedSprints: 0,
      reason: 'No signal yet — calibrating (cold-start).',
    };
  }

  const sorted = [...samples].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const earliest = new Date(sorted[0].at).getTime();
  const spanDays = (now.getTime() - earliest) / (1000 * 60 * 60 * 24);

  if (spanDays < BASELINE_WINDOW_DAYS) {
    return {
      status: 'calibrating',
      drifted: false,
      rollingMean: null,
      rollingStdDev: null,
      sustainedSprints: 0,
      reason: `Baseline incomplete (${spanDays.toFixed(1)}d / ${BASELINE_WINDOW_DAYS}d) — calibrating; structural detection is sole defense.`,
    };
  }

  // Active: compute rolling stats over the trailing 30d window.
  const cutoff = now.getTime() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowValues = sorted.filter((s) => new Date(s.at).getTime() >= cutoff).map((s) => s.value);
  // Fall back to the whole series if the trailing window is empty (sparse cadence).
  const values = windowValues.length > 0 ? windowValues : sorted.map((s) => s.value);

  const mu = mean(values);
  const sigma = populationStdDev(values, mu);
  const meanBreach = mu < MEAN_FLOOR;
  const stdDevBreach = sigma > STDDEV_CEILING;
  const conditionMet = meanBreach || stdDevBreach;

  const sustainedSprints = sprintFlags ? trailingTrueRun(sprintFlags) : conditionMet ? 1 : 0;
  const drifted = conditionMet && sustainedSprints >= SUSTAINED_SPRINTS;

  const reasons: string[] = [];
  if (meanBreach) reasons.push(`rolling 30d mean ${mu.toFixed(3)} < ${MEAN_FLOOR}`);
  if (stdDevBreach) reasons.push(`rolling 30d stddev ${sigma.toFixed(3)} > ${STDDEV_CEILING}`);
  const reason = drifted
    ? `${reasons.join(' and ')} sustained for ${sustainedSprints} sprint(s).`
    : conditionMet
      ? `${reasons.join(' and ')} but only ${sustainedSprints}/${SUSTAINED_SPRINTS} sustained sprints — not yet drifted.`
      : `Within bounds (mean ${mu.toFixed(3)}, stddev ${sigma.toFixed(3)}).`;

  return {
    status: 'active',
    drifted,
    rollingMean: mu,
    rollingStdDev: sigma,
    sustainedSprints,
    reason,
  };
}

/**
 * Project an `active` + `drifted` statistical result into a composition
 * `DriftEvent`. Returns `null` while calibrating or not drifted — there is
 * nothing to surface to the operator (AC-4: no statistical Decisions during
 * cold-start).
 */
export function toStatisticalDriftEvent(
  soulId: string,
  result: StatisticalDriftResult,
): DriftEvent | null {
  if (result.status !== 'active' || !result.drifted) return null;
  return {
    driftClass: 'statistical',
    soulId,
    severity: 'advisory',
    blocking: false,
    summary: `${STATISTICAL_DECISION_SLUG}: Soul "${soulId}" — ${result.reason}`,
    detail: result.reason,
  };
}

// ── Composition + catalog request building (AC-2, AC-3, AC-8) ──────────────

export interface ComposeDriftResult {
  /** All composed drift events (structural + statistical), side-by-side. */
  events: DriftEvent[];
  /**
   * Ready-to-file Decision requests, one per surfaced/blocked event, in the
   * same order as `events`. The caller forwards each to the RFC-0035 catalog
   * (`cli-decisions add` / `makeDecisionOpenedEvent`) — this module does NOT
   * write the event log itself (AC-8).
   */
  requests: DriftDecisionRequest[];
  /** True if any structural (blocking) drift is present — the CI hard gate. */
  blocked: boolean;
}

/** Build the catalog request for one composed drift event. */
export function toDecisionRequest(event: DriftEvent): DriftDecisionRequest {
  const isStructural = event.driftClass === 'structural';
  return {
    // Structural failures are emergent CI findings; statistical drift is a
    // framework-calibration signal. Both are valid catalog sources.
    source: isStructural ? 'emergent-finding' : 'framework-calibration',
    scope: DRIFT_DECISION_SCOPE,
    summary: event.summary,
    ...(event.detail !== undefined ? { body: event.detail } : {}),
    // Statistical drift is reversible/non-blocking (G0); structural is a hard
    // gate the operator must clear.
    reversible: !isStructural,
    options: [
      ...(isStructural ? STRUCTURAL_RECONCILIATION_OPTIONS : STATISTICAL_RECONCILIATION_OPTIONS),
    ],
  };
}

/**
 * Compose the structural gate outcome with a set of statistical results.
 *
 * - Structural events → `substrate-structural-drift-detected` (HIGH,
 *   blocking). Represented from the CI gate result; the gate itself already
 *   emits + blocks at CI time (AISDLC-453), so the catalog request here is the
 *   composition/audit projection (so structural + statistical sit
 *   side-by-side in one scope).
 * - Statistical drifted events → `soul-statistical-drift-detected`
 *   (advisory, non-blocking, G0) with the three reconciliation options.
 * - Calibrating / non-drifted statistical results emit NO request (AC-4).
 *
 * The pipeline never halts here: `blocked` reports the structural hard-gate
 * state for the CI caller to act on, but statistical drift never sets it.
 */
export function composeDrift(
  structural: StructuralGateResult,
  statistical: Array<{ soulId: string; result: StatisticalDriftResult }>,
): ComposeDriftResult {
  const structuralEvents = toStructuralDriftEvents(structural);
  const statisticalEvents: DriftEvent[] = [];
  for (const { soulId, result } of statistical) {
    const evt = toStatisticalDriftEvent(soulId, result);
    if (evt) statisticalEvents.push(evt);
  }
  const events = [...structuralEvents, ...statisticalEvents];

  return {
    events,
    requests: events.map(toDecisionRequest),
    blocked: structuralEvents.length > 0,
  };
}

// ── Catalog correlation (AC-3 / AC-5) ─────────────────────────────────────

/**
 * Group composed drift events by Soul DID so an operator can query
 * "show me all drift events for Soul X" and get both classes side-by-side.
 * Returns a map keyed by `soulId` whose values preserve event order.
 */
export function correlateDriftBySoul(events: DriftEvent[]): Map<string, DriftEvent[]> {
  const bySoul = new Map<string, DriftEvent[]>();
  for (const evt of events) {
    const list = bySoul.get(evt.soulId) ?? [];
    list.push(evt);
    bySoul.set(evt.soulId, list);
  }
  return bySoul;
}
