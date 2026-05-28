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
import type {
  Decision,
  DecisionEvent,
  DecisionOpenedEvent,
  RecommendationIssuedEvent,
  OperatorAnsweredEvent,
  OverriddenEvent,
  StageCCompletedEvent,
  TimeboxExtendedEvent,
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
