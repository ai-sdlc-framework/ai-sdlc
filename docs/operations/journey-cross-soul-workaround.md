# Cross-Soul Journeys: Per-Soul-With-Handoff Workaround

**RFC:** RFC-0018 section 10.1 OQ-9 (cross-soul journeys)
**Implemented:** AISDLC-470 (Phase 6)

Journeys are scoped to one Soul DID or Variant. A user path that spans several products (for example ProductA onboarding handing off to ProductB shift-start) is not a first-class framework concept in v1. This runbook documents the supported workaround.

## The pattern

1. **Each Soul owns its own journey.** ProductA declares `onboarding`; ProductB declares `shift-start`. Neither references the other.
2. **The sending journey ends in a handoff terminal state.** ProductA `onboarding` ends in `transitioned-to-product-b` with `terminal: true, successState: true`, so the framework counts the handoff as completion for ProductA.
3. **Correlate across souls with a shared identifier.** Carry the same `userId` (or `sessionId`) in work-item metadata and in the analytics events each product emits.
4. **The operator application owns orchestration.** The framework never routes a user from one Soul to another.
5. **The framework scores per Soul only.** A work item that targets `product-a/onboarding` and `product-b/shift-start` is aggregated with the per-Soul `crossJourneyAggregation` rule (default `min`); no cross-soul state is tracked.
6. **Cross-soul completion rate is computed by the operator's analytics pipeline**, joined on the shared correlation id. Push the result back as a `MetricSnapshot` on whichever journey should be boosted (see [journey-metrics.md](journey-metrics.md)).

## Sample multi-product flow

```yaml
# product-a: spec.journeys[]
- id: onboarding
  scope: soul
  states:
    - { id: signup, terminal: false }
    - { id: profile-setup, terminal: false }
    - { id: transitioned-to-product-b, terminal: true, successState: true }
    - { id: abandoned, terminal: true, successState: false }
  transitions:
    - { from: signup, to: profile-setup, trigger: signup-complete }
    - { from: profile-setup, to: transitioned-to-product-b, trigger: handoff-link-followed }
    - { from: profile-setup, to: abandoned, trigger: session-timeout }
  completionCriteria: { kind: terminal-success-state, target: transitioned-to-product-b }

# product-b: spec.journeys[]
- id: shift-start
  scope: soul
  states:
    - { id: login, terminal: false }
    - { id: shift-active, terminal: true, successState: true }
  transitions:
    - { from: login, to: shift-active, trigger: shift-started }
  completionCriteria: { kind: terminal-success-state, target: shift-active }
```

Both journeys carry `userId` in their events. The operator joins `product-a/onboarding` terminal events to `product-b/shift-start` start events on `userId` to measure end-to-end conversion.

## Activation: Decision Catalog Stage A counter

Requests for first-class cross-soul coordination are counted, not acted on. `trackCrossSoulCoordinationRequests()` in `orchestrator/src/variant/internal-adopter/journeys.ts` deduplicates by adopter and sets `promotedToOperatorReview` at 2 or more distinct adopters (`Decision: cross-soul-journey-coordination-request`). v1 has no activation surface: crossing the threshold flags the request for operator review and a possible follow-on RFC (non-blocking, RFC-0035 G0).

## Conformance

`orchestrator/src/journey/conformance.test.ts` validates that a handoff-terminal journey passes state-machine and schema validation without any cross-soul framework support.
