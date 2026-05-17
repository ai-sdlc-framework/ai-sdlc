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
      },
      status: {
        lifecycle: 'open',
        ...(opened.routing !== undefined ? { routing: opened.routing } : {}),
        ...(opened.capacity !== undefined ? { capacity: opened.capacity } : {}),
        ...(opened.deadline !== undefined ? { deadline: opened.deadline } : {}),
      },
      decisionLog: [...(current?.decisionLog ?? []), event],
    };
    return decision;
  }

  if (event.type === 'recommendation-issued') {
    // Phase 2 — AC#4: store Stage A signal breakdown on the Decision record.
    if (current === null) return null;
    const rec = event as RecommendationIssuedEvent;
    return {
      ...current,
      metadata: { ...current.metadata, updated: event.ts },
      status: {
        ...current.status,
        evaluation: {
          ...(current.status.evaluation ?? {}),
          stageA: rec.stageA,
        },
        priority: rec.prioritySignal,
        ...(rec.routing !== undefined ? { routing: rec.routing } : {}),
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
