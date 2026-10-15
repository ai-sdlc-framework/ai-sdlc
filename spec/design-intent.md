---
title: "DesignIntentDocument (DID)"
description: "Normative specification of the DesignIntentDocument (DID) resource introduced by RFC-0008."
---

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1
**Introduced by:** RFC-0008 (PPA Triad Integration)

The `DesignIntentDocument` (DID) is the resource that closes the
**Product↔Design** edge of the PPA triad. It captures the project's
**soul purpose** — mission, design principles, scope boundaries,
constraints, anti-patterns, and measurable signals — in a structured,
machine-readable form. The Soul Alignment (SA) scorer uses it to gate
which work items are admitted into the pipeline; the reconciler watches
it for drift against the resolved [DesignSystemBinding](./spec.md#5-core-resource-types)
(DSB) and emits `SoulGraphStale` / `CoreIdentityChanged` events when
core identity fields change.

## 1. Resource shape

A DID is a standard AI-SDLC resource. Every field below appears under
`spec.*`. Status fields are written by the reconciler, never by users.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: acme-did
  namespace: acme
spec:
  stewardship:
    productAuthority:
      owner: alice
      approvalRequired: [alice, bob]
      scope: [mission, scopeBoundaries]
    designAuthority:
      owner: design-lead
      approvalRequired: [design-lead]
      scope: [designPrinciples, brandIdentity]
    reviewCadence: quarterly        # quarterly | monthly | weekly
  soulPurpose:
    mission:
      value: "Help small businesses onboard in under 60 seconds."
      identityClass: core           # core | evolving (default: evolving)
    constraints:
      - id: no-developer-integration
        identityClass: core
        concept: "developer integration"
        relationship: must-not-require    # must-not-require | must-require | must-not-include | must-include
        detectionPatterns:
          - "requires developer"
          - "developer integration required"
    scopeBoundaries:
      inScope:
        - label: "customer onboarding"
          synonyms: ["account signup"]
          identityClass: core
      outOfScope:
        - label: "enterprise SSO"
          synonyms: [SAML, OIDC]
          identityClass: core
    antiPatterns:
      - id: wizard
        identityClass: core
        label: "multi-step wizard"
        detectionPatterns: ["setup wizard", "step 1 of"]
    designPrinciples:
      - id: approachable
        identityClass: core
        name: Approachable
        description: "Forms must feel simple and intuitive."
        measurableSignals:
          - id: time-to-value
            metric: secondsToFirstValue
            threshold: 60
            operator: lte           # gte | lte | gt | lt | eq | neq
        antiPatterns:
          - id: jargon
            label: "technical jargon"
            detectionPatterns: [DSL, YAML]
  brandIdentity:
    voiceAntiPatterns:
      - id: corporate-speak
        label: "corporate-speak"
        detectionPatterns: ["synergy", "leverage"]
    visualIdentity:
      visualConstraints:
        - id: palette-size
          label: "Palette size"
          rule: { metric: paletteCount, threshold: 3, operator: lte }
      visualAntiPatterns:
        - id: rainbow
          label: "rainbow gradients"
          detectionPatterns: [gradient]
  experientialTargets:
    perceivedComplexity: { target: low, identityClass: core }
    emotionalTone: { target: warm }
  designSystemRef:
    name: acme-ds                   # MUST resolve to a DesignSystemBinding
  plannedChanges:
    - id: chg-001
      changeType: token-restructure
      status: planned               # planned | in-progress | completed | cancelled
      description: "Restructure color tokens into semantic layer"
      estimatedTimeline: 2026-06-01
      affectedTokenPaths: [color.primary, color.secondary]
      estimatedComponentImpact: 12
      addedBy: design-lead
status:
  lastReviewed: "2026-04-01T00:00:00Z"
  nextReviewDue: "2026-07-01T00:00:00Z"
  conditions: []
```

## 2. Required fields

The schema (`spec/schemas/design-intent-document.schema.json`) enforces
the following minimum:

- `spec.stewardship.productAuthority` and `spec.stewardship.designAuthority` MUST be present.
- `spec.soulPurpose.mission.value` MUST be a non-empty string.
- `spec.soulPurpose.designPrinciples` MUST contain ≥ 1 entry, and each principle MUST contain ≥ 1 `measurableSignals` entry.
- `spec.designSystemRef.name` MUST resolve to a loaded `DesignSystemBinding` (cross-resource validation, performed by the config loader).
- A `plannedChanges[]` entry with `status: in-progress` MUST also set `addedBy`.

## 3. Identity classes (`core` vs `evolving`)

Every DID field that supports the `identityClass` discriminator falls
into one of two classes, with very different semantics:

| Class | Default | Drift behaviour | SA gate behaviour |
|---|---|---|---|
| `core` | — (must be set explicitly) | Mutation emits `CoreIdentityChanged`; in-flight work flagged `SoulGraphStale` | Hard gate (`hardGated = true`, SA-1 = 0) |
| `evolving` | yes | Mutation emits `EvolvingIdentityChanged` only | Soft warning, score reduced but not zeroed |

The classification is the lever the team uses to decide what is
**identity** (core: mission, in-scope boundaries, headline principles)
vs. what is allowed to **evolve** through normal product iteration
(evolving: tone, secondary scope, exploratory principles).

Nested anti-patterns inherit the parent principle's `identityClass`
unless they declare their own.

## 4. Cross-resource link

`spec.designSystemRef.name` MUST resolve to a `DesignSystemBinding`
loaded in the same config root. The link is **unidirectional**:

```
DesignIntentDocument ──ref──▶ DesignSystemBinding
```

The DSB surface is unchanged by RFC-0008; DSBs do not need to know
about DIDs. The config loader fails to load a DID whose `designSystemRef`
points to a non-existent binding.

The reconciler also performs a **semantic drift check**: for each
design principle, at least one DSB compliance rule (in
`disallowHardcoded[]` or `designReview.scope[]`) MUST mention one of
the principle's keyword stems. Principles with no matching rule produce
a `DesignIntentDrift` event.

## 5. Reconciler events

| Event | Trigger |
|---|---|
| `CoreIdentityChanged` | A field with `identityClass: core` was added, removed, or modified |
| `EvolvingIdentityChanged` | A field with `identityClass: evolving` (or default) changed |
| `SoulGraphStale` | A core change occurred AND `countInFlightItems(didName) > 0` — flags items as scored against a stale identity |
| `DesignIntentDrift` | A design principle has no matching DSB compliance rule |
| `ReviewOverdue` | `status.lastReviewed + reviewCadence` is in the past |
| `DesignChangePlanned` | A new entry with `status: planned` was added to `spec.plannedChanges[]` (suppressed on first reconciler run — that run captures the baseline) |

`CoreIdentityChanged` consumers MUST trigger a full backlog rescore and
emit `BacklogReshuffled` (see [API Reference: Soul Alignment](../docs/api-reference/design-intent.md#core-identity-changed-handler)).

## 6. SA-1 vs SA-2 — what does each check?

The DID feeds two of the seven PPA dimensions via three computational layers (§B.4–§B.7 of RFC-0008):

| Dimension | Question | Source |
|---|---|---|
| **SA-1** Domain Intent | "Is this work in our soul purpose at all?" | DID `mission`, `scopeBoundaries`, `constraints`, `antiPatterns` (product-level) |
| **SA-2** Principle Alignment | "Does this work embody our design principles?" | DID `designPrinciples`, `brandIdentity`, plus DSB `tokenCompliance` + `catalogHealth` (computable half) |

A `core` scope hit on SA-1 is a **hard gate** — the work item is
rejected outright (composite = 0). Evolving hits soften the score but
do not gate.

## 7. Worked example (§B.7.2)

```
SA-2 inputs
  tokenCompliance       = 0.88
  catalogHealth         = 0.95
  principleCoverage     = 0.72   (BM25 over principle corpora)
  principleAlignment    = 0.80   (LLM Layer 3)
  designConflictPenalty = 1.0    (no anti-pattern hits)
  weights (Phase 2c)    = { wStructural: 0.35, wLlm: 0.65 }

computableScore   = 0.3 × 0.88 + 0.2 × 0.95              = 0.454
blendedScore      = 0.35 × 0.72 + 0.65 × 0.80            = 0.772
llmComponent      = blendedScore × designConflictPenalty = 0.772
SA-2              = computableScore + 0.5 × llmComponent = 0.840
```

`computableScore` and `0.5 × llmComponent` each contribute up to 0.5 by
design — perfect inputs on both layers reach SA-2 = 1.0.

## 8. Phased rollout

The SA scorer is gated by `saScoring.phase` (one of `2a | 2b | 2c | 3`):

| Phase | Layer 1 | Layer 2 (BM25) | Layer 3 (LLM) | Used in admission? |
|---|---|---|---|---|
| `2a` (shadow) | yes | yes | yes | no — caller falls back to label-based `soulAlignment` |
| `2b` | yes | yes | yes | yes — `wStructural=0.20, wLlm=0.80` |
| `2c` | yes | yes | yes | yes — `wStructural=0.35, wLlm=0.65` |
| `3` (calibrated) | yes | yes | yes | yes — weights learned via `auto-calibrate` |

The `wStructural ≥ 0.20` floor (CR-2) is enforced both in code and as
a SQLite `CHECK` constraint on `sa_phase_weights`.

## 9. Authoring checklist

When you write a DID, the most common mistakes are:

1. **Empty principles.** Each principle needs ≥ 1 measurable signal — the schema rejects DIDs without them.
2. **Forgotten `identityClass`.** A field with no `identityClass` defaults to `evolving`. If the team treats it as identity, mark it `core` explicitly.
3. **Pattern false-positives > 20%.** Validate each `detectionPatterns` set against the [`pattern-test`](../docs/api-reference/design-intent.md#pattern-test-cli) CLI with a labelled fixture set before promoting to Phase 2b.
4. **Brand voice without anti-patterns.** A `brandIdentity` with an empty `voiceAntiPatterns` array adds no SA-2 signal.
5. **DSB ref drift.** When you rename a DSB, you MUST also update the DID's `designSystemRef.name` — config validation rejects the mismatch.
