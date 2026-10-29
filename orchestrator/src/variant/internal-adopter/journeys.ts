/**
 * RFC-0018 Phase 6 — InternalAdopter journey reference implementation
 * (AISDLC-470, RFC-0018 §11 practitioner validation).
 *
 * Ships journey declarations for ProductA / ProductB / ProductC / ProductD as
 * canonical fixtures for the In-Soul Journey Pattern, plus:
 *   - `validateJourneyStateMachine()` — reachability + terminal-marking check
 *   - `buildAuditReport()` — WCAG audit report keyed 1:1 by journey URI
 *   - `trackCrossSoulCoordinationRequests()` — Stage A counter for
 *     `Decision: cross-soul-journey-coordination-request` (no v1 activation
 *     surface; v1 workaround is per-soul-with-handoff).
 *
 * @see spec/rfcs/RFC-0018-in-soul-journey-pattern.md §11
 * @see docs/operations/journey-cross-soul-workaround.md
 * @see docs/operations/journey-pattern-promotion.md
 */

import type { JourneyDeclaration, WcagLevel } from '../../journey-sa2-router.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface InternalAdopterJourneyState {
  readonly id: string;
  readonly terminal: boolean;
  readonly successState?: boolean;
}

export interface InternalAdopterJourneyTransition {
  readonly from: string | readonly string[];
  readonly to: string;
  readonly trigger: string;
}

/** Journey declaration matching `spec/schemas/journey.v1.schema.json`. */
export interface InternalAdopterJourney extends JourneyDeclaration {
  readonly states: readonly InternalAdopterJourneyState[];
  readonly transitions: readonly InternalAdopterJourneyTransition[];
  readonly complianceFloor?: 'inherit';
}

export interface InternalAdopterJourneySoul {
  readonly soulId: string;
  /** Soul-level WCAG default (journeys may only elevate above it). */
  readonly soulWcagDefault: WcagLevel;
  readonly journeys: readonly InternalAdopterJourney[];
}

// ── Builders ──────────────────────────────────────────────────────────

interface LinearSpec {
  readonly id: string;
  readonly scope: InternalAdopterJourney['scope'];
  /** Ordered happy-path state ids; the last one is the success terminal. */
  readonly path: readonly string[];
  /** Extra terminal failure state id reachable from the first non-initial state. */
  readonly abandonedAs?: string;
  readonly wcagLevel?: WcagLevel;
  readonly metrics?: boolean;
  readonly cadence?: 'quarterly' | 'annually' | 'release-gated' | 'continuous';
  readonly extraTerminalSuccess?: string;
}

function linear(spec: LinearSpec): InternalAdopterJourney {
  const { id, scope, path } = spec;
  const abandoned = spec.abandonedAs ?? 'abandoned';
  const last = path[path.length - 1];
  const states: InternalAdopterJourneyState[] = path.map((s, i) =>
    i === path.length - 1
      ? { id: s, terminal: true, successState: true }
      : { id: s, terminal: false },
  );
  states.push({ id: abandoned, terminal: true, successState: false });
  const transitions: InternalAdopterJourneyTransition[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    transitions.push({ from: path[i], to: path[i + 1], trigger: `advance-${path[i + 1]}` });
  }
  transitions.push({
    from: path.slice(1, -1),
    to: abandoned,
    trigger: 'session-timeout',
  });
  const journey: InternalAdopterJourney = {
    id,
    scope,
    states,
    transitions,
    completionCriteria: { kind: 'terminal-success-state', target: last },
    accessibility: {
      wcagLevel: spec.wcagLevel ?? 'AA',
      wcagVersion: '2.2',
      conformanceTarget: 100,
      auditCadence: spec.cadence ?? 'quarterly',
    },
    successMetrics:
      spec.metrics === false
        ? []
        : [
            { id: 'completion-rate', target: 0.7, alertBelow: 0.5 },
            { id: 'median-time-to-completion', targetSeconds: 600, alertAbove: 1200 },
          ],
    designImperatives: [`${id}-clarity`],
    ...(scope.startsWith('variant:') ? { complianceFloor: 'inherit' as const } : {}),
  };
  return journey;
}

// ── ProductA — multi-flow per soul ────────────────────────────────────

export const journeysProductA: InternalAdopterJourneySoul = {
  soulId: 'product-a',
  soulWcagDefault: 'AA',
  journeys: [
    linear({
      id: 'onboarding',
      scope: 'soul',
      path: ['signup', 'profile-setup', 'first-task', 'onboarded'],
    }),
    linear({
      id: 'daily-task-management',
      scope: 'soul',
      path: ['dashboard-open', 'task-selected', 'task-updated', 'day-closed'],
      cadence: 'release-gated',
    }),
    linear({
      id: 'billing-inquiry-resolution',
      scope: 'soul',
      path: ['inquiry-opened', 'account-located', 'adjustment-applied', 'inquiry-resolved'],
    }),
  ],
};

// ── ProductB — mobile form-factor ─────────────────────────────────────

export const journeysProductB: InternalAdopterJourneySoul = {
  soulId: 'product-b',
  soulWcagDefault: 'AA',
  journeys: [
    linear({
      id: 'shift-start',
      scope: 'soul',
      path: ['login', 'vehicle-check', 'route-loaded', 'shift-active'],
    }),
    linear({
      id: 'route-completion',
      scope: 'soul',
      path: ['stop-arrived', 'work-performed', 'photo-captured', 'route-complete'],
    }),
    linear({
      id: 'end-of-shift-handoff',
      scope: 'soul',
      path: ['shift-ending', 'notes-recorded', 'handoff-signed', 'handed-off'],
    }),
  ],
};

// ── ProductC — variant-scoped (csr vs customer-portal) ────────────────

export const journeysProductC: InternalAdopterJourneySoul = {
  soulId: 'product-c',
  soulWcagDefault: 'AA',
  journeys: [
    linear({
      id: 'csr-onboarding',
      scope: 'variant:csr',
      path: ['csr-login', 'queue-orientation', 'first-case', 'csr-ready'],
    }),
    linear({
      id: 'customer-self-service',
      scope: 'variant:customer-portal',
      path: ['portal-landing', 'account-verified', 'request-submitted', 'request-fulfilled'],
    }),
    linear({
      id: 'dispute-resolution',
      scope: 'soul',
      path: ['dispute-filed', 'evidence-collected', 'review-complete', 'dispute-closed'],
      wcagLevel: 'AAA',
    }),
  ],
};

// ── ProductD / annual-test — regulatory, WCAG AAA elevation ───────────

export const journeysProductD: InternalAdopterJourneySoul = {
  soulId: 'product-d',
  soulWcagDefault: 'AA',
  journeys: [
    linear({
      id: 'submit-test-results',
      scope: 'variant:annual-test',
      path: ['test-selected', 'results-entered', 'results-reviewed', 'results-submitted'],
      wcagLevel: 'AAA',
      cadence: 'annually',
    }),
    linear({
      id: 'request-extension',
      scope: 'variant:annual-test',
      path: ['extension-started', 'justification-entered', 'extension-filed'],
      wcagLevel: 'AAA',
      cadence: 'annually',
    }),
    linear({
      id: 'view-historical-tests',
      scope: 'variant:annual-test',
      path: ['history-opened', 'filter-applied', 'record-viewed'],
      wcagLevel: 'AAA',
      cadence: 'annually',
    }),
  ],
};

export const INTERNAL_ADOPTER_JOURNEY_SOULS: readonly InternalAdopterJourneySoul[] = [
  journeysProductA,
  journeysProductB,
  journeysProductC,
  journeysProductD,
];

/** Path-style journey URI (`soul/journey` or `soul/variant/journey`). */
export function journeyUri(soulId: string, journey: InternalAdopterJourney): string {
  return journey.scope.startsWith('variant:')
    ? `${soulId}/${journey.scope.slice('variant:'.length)}/${journey.id}`
    : `${soulId}/${journey.id}`;
}

// ── State-machine validation (AC #5) ──────────────────────────────────

export interface StateMachineIssue {
  readonly kind:
    | 'unreachable-state'
    | 'unknown-transition-state'
    | 'terminal-missing-success-flag'
    | 'terminal-has-outgoing-transition'
    | 'no-success-terminal'
    | 'completion-target-not-success-terminal'
    | 'duplicate-state-id';
  readonly stateId?: string;
}

/**
 * Validate that a journey's states + transitions form a valid state machine.
 * The first declared state is the initial state.
 */
export function validateJourneyStateMachine(journey: InternalAdopterJourney): StateMachineIssue[] {
  const issues: StateMachineIssue[] = [];
  const ids = new Set<string>();
  for (const s of journey.states) {
    if (ids.has(s.id)) issues.push({ kind: 'duplicate-state-id', stateId: s.id });
    ids.add(s.id);
    if (s.terminal && s.successState === undefined) {
      issues.push({ kind: 'terminal-missing-success-flag', stateId: s.id });
    }
  }
  const terminals = new Set(journey.states.filter((s) => s.terminal).map((s) => s.id));
  const edges = new Map<string, string[]>();
  for (const t of journey.transitions) {
    const froms = typeof t.from === 'string' ? [t.from] : t.from;
    for (const f of froms) {
      for (const endpoint of [f, t.to]) {
        if (!ids.has(endpoint))
          issues.push({ kind: 'unknown-transition-state', stateId: endpoint });
      }
      if (terminals.has(f)) issues.push({ kind: 'terminal-has-outgoing-transition', stateId: f });
      edges.set(f, [...(edges.get(f) ?? []), t.to]);
    }
  }
  const reached = new Set<string>();
  const queue = journey.states.length > 0 ? [journey.states[0].id] : [];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (reached.has(cur)) continue;
    reached.add(cur);
    queue.push(...(edges.get(cur) ?? []));
  }
  for (const s of journey.states) {
    if (!reached.has(s.id)) issues.push({ kind: 'unreachable-state', stateId: s.id });
  }
  const successTerminals = journey.states.filter((s) => s.terminal && s.successState === true);
  if (successTerminals.length === 0) issues.push({ kind: 'no-success-terminal' });
  const target = journey.completionCriteria.target;
  if (
    journey.completionCriteria.kind === 'terminal-success-state' &&
    !successTerminals.some((s) => s.id === target)
  ) {
    issues.push({ kind: 'completion-target-not-success-terminal', stateId: target });
  }
  return issues;
}

// ── WCAG audit report mapping (AC #6) ─────────────────────────────────

export interface JourneyAuditReport {
  /** Target journey URI — exactly one report per declared journey. */
  readonly targetJourney: string;
  readonly wcagLevel: WcagLevel;
  readonly wcagVersion: string;
  readonly elevatedAboveSoul: boolean;
}

const LEVEL_RANK: Record<WcagLevel, number> = { A: 1, AA: 2, AAA: 3 };

/** Build one audit report per journey declaration (1:1 mapping). */
export function buildAuditReports(soul: InternalAdopterJourneySoul): JourneyAuditReport[] {
  return soul.journeys.map((j) => ({
    targetJourney: journeyUri(soul.soulId, j),
    wcagLevel: j.accessibility.wcagLevel,
    wcagVersion: j.accessibility.wcagVersion,
    elevatedAboveSoul: LEVEL_RANK[j.accessibility.wcagLevel] > LEVEL_RANK[soul.soulWcagDefault],
  }));
}

// ── Cross-soul coordination Stage A counter (AC #10) ──────────────────

export const CROSS_SOUL_COORDINATION_DECISION_KIND =
  'cross-soul-journey-coordination-request' as const;

export const DEFAULT_CROSS_SOUL_COORDINATION_THRESHOLD = 2;

export interface CrossSoulCoordinationRequest {
  /** Distinct adopter identifier (deduplication key). */
  readonly requestedBy: string;
}

export interface CrossSoulCoordinationCounterResult {
  readonly decision: typeof CROSS_SOUL_COORDINATION_DECISION_KIND;
  readonly distinctAdopterCount: number;
  readonly threshold: number;
  readonly promotedToOperatorReview: boolean;
  readonly adopters: readonly string[];
}

/**
 * Stage A counter only: accumulates distinct adopter requests for first-class
 * cross-soul journeys. v1 has NO activation surface — reaching the threshold
 * only flags the request for operator review (RFC-0035 G0, non-blocking).
 */
export function trackCrossSoulCoordinationRequests(
  requests: readonly CrossSoulCoordinationRequest[],
  threshold: number = DEFAULT_CROSS_SOUL_COORDINATION_THRESHOLD,
): CrossSoulCoordinationCounterResult {
  const adopters = [...new Set(requests.map((r) => r.requestedBy).filter(Boolean))];
  return {
    decision: CROSS_SOUL_COORDINATION_DECISION_KIND,
    distinctAdopterCount: adopters.length,
    threshold,
    promotedToOperatorReview: adopters.length >= threshold,
    adopters,
  };
}
