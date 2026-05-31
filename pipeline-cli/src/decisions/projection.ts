/**
 * RFC-0035 Decision projection — materialize the `Decision` view from the
 * append-only event log.
 *
 * The projection is a left fold over events sharing the same `decisionId`,
 * applied in append order. Phase 1 only emits `decision-opened` events, so
 * the projection is trivial; later phases extend `applyEvent` with deltas
 * for `operator-answered`, `superseded`, `routing-changed`, etc.
 *
 * Forward-compat: unknown event types are folded into the `decisionLog`
 * (so `cli-decisions show` still surfaces them) but produce no state
 * mutation. This lets a newer reader gracefully consume a log written by
 * a forward-incompatible writer.
 *
 * @module decisions/projection
 */

import { readDecisionEvents, type ReadEventsOpts } from './event-log.js';
import { msRemainingUntil } from './timebox.js';
import {
  DECISION_PRIORITY_WEIGHTS,
  type AutoExpiredEvent,
  type Decision,
  type DecisionEvent,
  type DecisionOpenedEvent,
  type DecisionPriority,
  type RecommendationIssuedEvent,
  type OperatorAnsweredEvent,
  type OverriddenEvent,
  type StageCCompletedEvent,
  type TimeboxExtendedEvent,
} from './decision-record.js';

/**
 * Apply one event to the projected Decision state. `null` for `current`
 * means "no decision exists yet" — the only event that can transition
 * from null → populated is `decision-opened`. Any other first event is
 * dropped (logged in `decisionLog` only) because it has no base state to
 * mutate.
 */
function applyEvent(current: Decision | null, event: DecisionEvent): Decision | null {
  if (event.type === 'decision-opened') {
    const opened = event as DecisionOpenedEvent;
    // If the same decisionId is opened twice, the later open replaces the
    // earlier (operator-edited-the-log degraded path) but the decisionLog
    // preserves both events for audit. This matches the "last-write-wins
    // within a single decision-id" semantics RFC §4.2 implies.
    const decision: Decision = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: {
        id: opened.decisionId,
        source: opened.source,
        scope: opened.scope,
        created: current?.metadata.created ?? opened.ts,
        updated: opened.ts,
      },
      spec: {
        summary: opened.summary,
        ...(opened.body !== undefined ? { body: opened.body } : {}),
        ...(opened.reversible !== undefined ? { reversible: opened.reversible } : {}),
        options: opened.options,
        ...(opened.dependsOn !== undefined ? { dependsOn: opened.dependsOn } : {}),
        ...(opened.timebox !== undefined ? { timebox: opened.timebox } : {}),
        // AISDLC-463 — operator-authored ranking + fallback + context fields.
        ...(opened.priority !== undefined ? { priority: opened.priority } : {}),
        ...(opened.impactScore !== undefined ? { impactScore: opened.impactScore } : {}),
        ...(opened.autonomousFallbackOptionId !== undefined
          ? { autonomousFallbackOptionId: opened.autonomousFallbackOptionId }
          : {}),
        ...(opened.contextRef !== undefined ? { contextRef: opened.contextRef } : {}),
      },
      status: {
        lifecycle: 'open',
        ...(opened.routing !== undefined ? { routing: opened.routing } : {}),
        ...(opened.capacity !== undefined ? { capacity: opened.capacity } : {}),
        ...(opened.deadline !== undefined ? { deadline: opened.deadline } : {}),
        ...(opened.timeboxExpiresAt !== undefined
          ? { timeboxExpiresAt: opened.timeboxExpiresAt }
          : {}),
      },
      decisionLog: [...(current?.decisionLog ?? []), event],
    };
    return decision;
  }

  if (event.type === 'timebox-extended') {
    // RFC-0035 AISDLC-447 — operator-extension of an existing timebox.
    // Fold the new expiry onto status.timeboxExpiresAt + record the new
    // canonical duration on spec.timebox so subsequent reads show the
    // current ground truth (the audit trail of every prior timebox lives
    // in decisionLog).
    if (current === null) return null;
    const ext = event as TimeboxExtendedEvent;
    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      spec: {
        ...current.spec,
        timebox: ext.newTimebox,
      },
      status: {
        ...current.status,
        timeboxExpiresAt: ext.newTimeboxExpiresAt,
      },
      decisionLog: [...current.decisionLog, event],
    };
  }

  if (event.type === 'recommendation-issued') {
    // Phase 2 — AC#4: store Stage A signal breakdown on the Decision record.
    // Phase 3 — also fold Stage B rubric scores + routing (actorRationale, subActors).
    if (current === null) return null;
    const rec = event as RecommendationIssuedEvent;

    // Build evaluation update: always set stageA; set stageB when present.
    const evaluationUpdate: Record<string, unknown> = {
      ...(current.status.evaluation ?? {}),
      stageA: rec.stageA,
    };
    if (rec.stageB !== undefined) {
      evaluationUpdate.stageB = rec.stageB;
    }

    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      status: {
        ...current.status,
        evaluation: evaluationUpdate,
        priority: rec.prioritySignal,
        ...(rec.routing !== undefined ? { routing: rec.routing } : {}),
      },
      decisionLog: [...current.decisionLog, event],
    };
  }

  if (event.type === 'stage-c-completed') {
    // RFC-0035 Phase 5 / AISDLC-289 — fold Stage C output onto the Decision
    // record. The companion `operator-answered` event (when `autoApplied: true`)
    // is folded separately below.
    if (current === null) return null;
    const sc = event as StageCCompletedEvent;
    const evaluationUpdate: Record<string, unknown> = {
      ...(current.status.evaluation ?? {}),
      stageC: sc.stageC,
    };
    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      status: {
        ...current.status,
        evaluation: evaluationUpdate,
      },
      decisionLog: [...current.decisionLog, event],
    };
  }

  if (event.type === 'overridden') {
    // RFC-0035 Phase 5 / AISDLC-289 — fold operator override of a
    // framework auto-applied recommendation. The decision lifecycle
    // resolves to 'answered' with the override's chosen option as the
    // canonical answer; `answeredBy` records the operator.
    if (current === null) return null;
    const ovr = event as OverriddenEvent;
    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      status: {
        ...current.status,
        lifecycle: 'answered',
        answeredOptionId: ovr.chosenOptionId,
        answeredBy: event.by ?? null,
        answeredAt: event.ts,
      },
      decisionLog: [...current.decisionLog, event],
    };
  }

  if (event.type === 'operator-answered') {
    // RFC-0035 Phase 4 / AC#3 — fold operator answer into the Decision
    // state: lifecycle → 'answered', capture chosenOptionId + actor + ts.
    if (current === null) return null; // no base state to fold into
    const answered = event as OperatorAnsweredEvent;
    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      status: {
        ...current.status,
        lifecycle: 'answered',
        answeredOptionId: answered.chosenOptionId,
        answeredBy: event.by ?? null,
        answeredAt: event.ts,
      },
      decisionLog: [...current.decisionLog, event],
    };
  }

  if (event.type === 'auto-expired') {
    // AISDLC-463 — autonomous fallback at timebox expiry. The fallback IS the
    // answer, so the decision lifecycle resolves to 'answered' with
    // `answeredBy: 'auto-expired'` (the factory hard-codes `by`), distinguishing
    // it from an operator answer in the audit trail.
    if (current === null) return null;
    const expired = event as AutoExpiredEvent;
    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      status: {
        ...current.status,
        lifecycle: 'answered',
        answeredOptionId: expired.chosenOptionId,
        answeredBy: event.by ?? 'auto-expired',
        answeredAt: event.ts,
      },
      decisionLog: [...current.decisionLog, event],
    };
  }

  // Unknown / forward-compat events: log only, no state mutation. The
  // projection is intentionally tolerant so a Phase-1 reader can still
  // surface a log written by Phase 2+ without crashing.
  if (current === null) return null;
  return {
    ...current,
    metadata: { ...current.metadata, updated: event.ts },
    decisionLog: [...current.decisionLog, event],
  };
}

/**
 * Project every event in the log into a map of `decisionId → Decision`.
 */
export function projectAll(opts: ReadEventsOpts = {}): {
  decisions: Map<string, Decision>;
  skipped: number;
} {
  const { events, skipped } = readDecisionEvents(opts);
  const decisions = new Map<string, Decision>();
  for (const event of events) {
    const current = decisions.get(event.decisionId) ?? null;
    const next = applyEvent(current, event);
    if (next !== null) decisions.set(event.decisionId, next);
  }
  return { decisions, skipped };
}

/**
 * Project a single decision by id. Returns null when no `decision-opened`
 * event with that id exists in the log.
 */
export function projectDecision(decisionId: string, opts: ReadEventsOpts = {}): Decision | null {
  const { decisions } = projectAll(opts);
  return decisions.get(decisionId) ?? null;
}

/**
 * Convenience: list every projected decision sorted by `metadata.created`
 * ascending (oldest first). `cli-decisions list` uses this directly.
 */
export function listDecisions(opts: ReadEventsOpts = {}): {
  decisions: Decision[];
  skipped: number;
} {
  const { decisions, skipped } = projectAll(opts);
  const list = Array.from(decisions.values());
  list.sort((a, b) => a.metadata.created.localeCompare(b.metadata.created));
  return { decisions: list, skipped };
}

// ── Timebox-aware sort + filter (RFC-0035 AISDLC-447) ────────────────────────

/**
 * Sort decisions by timebox-remaining ascending (most-urgent first).
 *
 * Within the timeboxed set, decisions are ordered by `timeboxExpiresAt`
 * ascending (earliest = most-urgent). Decisions without a timebox sort
 * after all timeboxed ones, in `metadata.created` ascending order so the
 * existing creation-order behaviour is preserved for the untimeboxed tail.
 *
 * The function is pure and returns a new array — the input is not mutated.
 */
export function sortDecisionsByTimeboxUrgency(decisions: Decision[]): Decision[] {
  const copy = [...decisions];
  copy.sort((a, b) => {
    const aExp = a.status.timeboxExpiresAt ?? null;
    const bExp = b.status.timeboxExpiresAt ?? null;
    if (aExp && bExp) {
      const cmp = aExp.localeCompare(bExp);
      if (cmp !== 0) return cmp;
      return a.metadata.created.localeCompare(b.metadata.created);
    }
    if (aExp && !bExp) return -1; // timeboxed before untimeboxed
    if (!aExp && bExp) return 1;
    return a.metadata.created.localeCompare(b.metadata.created);
  });
  return copy;
}

/**
 * True when the decision's timebox is set AND in the past relative to `now`.
 * Decisions without a timebox can never be "expired" — they sort to the
 * bottom of the urgency list but `--expired` filters them out.
 */
export function isDecisionTimeboxExpired(decision: Decision, now: Date = new Date()): boolean {
  const exp = decision.status.timeboxExpiresAt;
  if (!exp) return false;
  const t = Date.parse(exp);
  if (!Number.isFinite(t)) return false;
  return t < now.getTime();
}

/**
 * Filter to only decisions whose timebox has expired AND that are still
 * unresolved (lifecycle ≠ 'answered' / 'archived' / 'superseded'). Resolved
 * decisions are excluded — once the operator answered, the timebox is moot.
 */
export function filterExpiredDecisions(decisions: Decision[], now: Date = new Date()): Decision[] {
  return decisions.filter((d) => {
    if (!isDecisionTimeboxExpired(d, now)) return false;
    const lc = d.status.lifecycle;
    return lc !== 'answered' && lc !== 'archived' && lc !== 'superseded';
  });
}

// ── Priority ranking (RFC-0035 AISDLC-463) ───────────────────────────────────

/**
 * AISDLC-463 — `list --ranked` ranking formula.
 *
 * `rankScore = priorityWeight × impactFactor × urgencyDecay`
 *
 * where:
 *   - **priorityWeight** — categorical weight (critical=4, high=3, medium=2,
 *     low=1). Absent priority defaults to `low` (weight 1) so untyped
 *     decisions rank deterministically last among same-impact peers.
 *   - **impactFactor** — `impactScore / 100`, mapped from the operator-authored
 *     [0,100] score into [0,1]. Absent impact defaults to 0.5 (a neutral
 *     midpoint) so it neither inflates nor suppresses rank relative to scored
 *     peers. We use `(impactScore / 100) + 1` internally (range [1,2]) so a
 *     zero impact never collapses the whole product to 0 — priority always
 *     contributes.
 *   - **urgencyDecay** — a monotone-increasing-as-deadline-approaches factor
 *     derived from the timebox. A decision past its expiry gets the maximum
 *     urgency; a decision far from expiry gets ~1.0; an untimeboxed decision
 *     gets a neutral 1.0. Concretely:
 *       expired (msRemaining ≤ 0)            → 3.0  (most urgent)
 *       within 1h of expiry                  → 2.0
 *       within 24h of expiry                 → 1.5
 *       beyond 24h, or untimeboxed           → 1.0
 *     The step function (rather than a continuous decay) keeps the order
 *     deterministic and easy to reason about in tests.
 *
 * Higher `rankScore` = surfaces sooner. Ties (identical score) break by
 * `metadata.created` ascending (oldest first) so the order is fully
 * deterministic and stable across runs.
 */
export function computeRankScore(decision: Decision, now: Date = new Date()): number {
  const priority: DecisionPriority = decision.spec.priority ?? 'low';
  const priorityWeight = DECISION_PRIORITY_WEIGHTS[priority];

  const impact = typeof decision.spec.impactScore === 'number' ? decision.spec.impactScore : 50;
  // Map [0,100] → [1,2] so impact modulates but never zeroes the product.
  const impactFactor = impact / 100 + 1;

  const msRemaining = msRemainingUntil(decision.status.timeboxExpiresAt, now);
  let urgencyDecay: number;
  if (msRemaining === null) {
    urgencyDecay = 1.0; // untimeboxed — neutral
  } else if (msRemaining <= 0) {
    urgencyDecay = 3.0; // already expired — most urgent
  } else if (msRemaining <= 60 * 60 * 1000) {
    urgencyDecay = 2.0; // within 1h
  } else if (msRemaining <= 24 * 60 * 60 * 1000) {
    urgencyDecay = 1.5; // within 24h
  } else {
    urgencyDecay = 1.0; // beyond 24h
  }

  return priorityWeight * impactFactor * urgencyDecay;
}

/**
 * AISDLC-463 — order decisions by descending {@link computeRankScore}
 * (most-urgent first). Ties break by `metadata.created` ascending so the
 * result is deterministic. Pure: returns a new array, input is not mutated.
 */
export function rankDecisions(decisions: Decision[], now: Date = new Date()): Decision[] {
  const scored = decisions.map((d) => ({ d, score: computeRankScore(d, now) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.d.metadata.created.localeCompare(b.d.metadata.created);
  });
  return scored.map((s) => s.d);
}
