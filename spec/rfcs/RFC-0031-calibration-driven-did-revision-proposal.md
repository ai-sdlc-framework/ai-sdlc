---
id: RFC-0031
title: Calibration-Driven DID Revision Proposal Mechanism
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0005
  - RFC-0008
  - RFC-0009
  - RFC-0029
  - RFC-0030
requiresDocs: []
---

# RFC-0031: Calibration-Driven DID Revision Proposal Mechanism

**Document type:** Normative (draft)
**Status:** Draft v1 — Initial proposal. Defines the PPA-calibration-flywheel-driven mechanism that proposes DID revisions when accumulated evidence shows the DID's articulation has drifted from observed reality.
**Lifecycle:** Draft
**Authors:** Alexander Kline (Head of Product Strategy / Product Authority; PPA v1.0/v1.1 author)
**Requires:** RFC-0005 (PPA), RFC-0008 (PPA Triad Integration), RFC-0009 (Tessellated DIDs — schema target), RFC-0029 (Product Pillar Architectural Vision — Principle 3 "DID as Canonical Soul Reference"), RFC-0030 (Signal Ingestion Pipeline — demand-misalignment evidence source)

> The bold-style status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

## Scope note

This RFC defines a **PPA mechanism** (the proposal-generation path), not a **DID schema change** (the target shape). Per the framework's three-axis basis (Product DECLARES identity; Engineering MAINTAINS coherence; Design EXPRESSES identity), DID schema authorship lives with RFC-0009 (Mo + Dom + Alex collectively); the PPA flywheel that *triggers* a revision proposal lives with PPA (Alex). This RFC covers only the trigger mechanism + classification + approval routing.

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Alexander Kline | Head of Product Strategy / Product Authority | ✍️ Authored v1 | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ⏸ Pending | — |
| Morgan Hirtle | Chief of Design / Design Authority | ⏸ Pending | — |

## Revision History

| Version | Date | Author | Notes |
|---------|------|--------|-------|
| v1 | 2026-05-04 | Alexander | Initial draft. Defines `DIDRevisionProposal` event triggered by accumulated PPA flywheel evidence; scope restricted to Shard DIDs (platform Tessellated DID changes are human-initiated only); healthy/unhealthy/ambiguous drift classification; triad-vs-pillar-lead approval routing; 14-day proposal expiry. |

---

## 1. Summary

PPA v1.2's calibration flywheel (the accept/dismiss/escalate/override signals plus the SoulDriftDetected event) accumulates evidence about where the DID's articulation diverges from observed reality. Today, this evidence is recorded but not actioned. Operators are expected to notice drift signals manually, decide a revision is warranted, and update the DID by hand.

This RFC defines a **calibration-driven DID revision proposal mechanism**: when accumulated flywheel evidence crosses defined thresholds, PPA generates a structured `DIDRevisionProposal` event surfacing the proposed change, the supporting evidence, and the recommended approval path.

The mechanism is **proposal-only**. PPA does not modify the DID. The triad (or the relevant pillar lead, depending on the field's `identityClass`) reviews and decides. Human authorship of identity is preserved; the flywheel just stops drift from going unnoticed.

## 2. Motivation

### 2.1 The DID is not a static document

Per RFC-0029 Principle 3, the DID is the "best available articulation of the product's identity, not the identity itself." The identity converges from what was stated, what was built, what was validated, and what the market rewarded. A well-written DID has high fidelity to this convergence; over time, fidelity decays as the product evolves and the DID doesn't.

The flywheel is the framework's primary mechanism for detecting fidelity decay:

- High dismiss-signal count on issues where the operator's actual judgment diverges from PPA's score → the DID's stated priorities don't match observed practice
- SA resonance gap between demand clusters and DID fields → the DID's stated mission doesn't match what customers actually ask for
- SoulDriftDetected events → 30-day rolling SA mean has dropped below threshold

Without a structured proposal mechanism, this evidence accumulates in calibration logs nobody reviews.

### 2.2 Drift is not always bad

Per RFC-0029 Principle 4, drift in response to real customer needs is the system working — the product evolving toward its market. Drift away from the product's gravitational center because noise is overwhelming signal is the system failing. Both produce the same statistical signal (declining SA resonance); distinguishing them requires evidence-package evaluation.

The proposal mechanism must include classification logic that distinguishes healthy from unhealthy drift, so the recommended response differs:

- Healthy → propose DID revision (catch up to legitimate evolution)
- Unhealthy → propose admission threshold tightening (filter the noise)
- Ambiguous → flag for triad review with full evidence package

### 2.3 Scope must be Shard-DID only

Platform-level DID changes affect every Soul DID inheriting from the platform. Tightening-only inheritance (per RFC-0009 §5.1 + RFC-0006 v5) means a platform-DID tightening cascades to all shards' inherited invariants. That's too consequential for an automated proposal — platform DID revisions belong to humans, with full triad review at platform scope.

For single-product platforms (no tessellation), the single DID IS the shard DID; this scope constraint has no practical effect.

## 3. Goals

1. **Structured proposal event** — `DIDRevisionProposal` with target field, proposed value, evidence package, identityClass, recommended approval path
2. **Evidence-driven triggers** — defined thresholds on flywheel signals (dismiss count, SA misalignment sustained, attributable drift events)
3. **Healthy/unhealthy/ambiguous classification** — automatic, evidence-backed, with criteria the triad can verify
4. **Approval routing by `identityClass`** — `core` fields require full triad; `evolving` fields require owning pillar lead + one other pillar lead
5. **Bounded lifetime** — proposals expire after 14 days if not reviewed; expiry is a signal that the review process needs unblocking, not silent dismissal
6. **Shard-DID-only scope** — platform Tessellated DID changes are human-initiated only
7. **Audit trail** — every proposal logged: trigger evidence, classification logic, approval/rejection rationale

## 4. Non-Goals

1. **Not a DID editor** — PPA proposes; humans approve and edit. No automatic merge of proposed changes
2. **Not a DID schema specification** — DID structure (fields, identityClass, inheritance rules) lives in RFC-0009 and PPA v1.2 direction
3. **Not a UX flow** — the surface where humans review proposals is a separate concern (likely TUI per RFC-0023)
4. **Not retroactive** — proposals only consider flywheel evidence accumulated after the mechanism activates
5. **Not multi-DID coordination** — each proposal targets one field on one DID; cross-shard or cross-field bundles defer to a future RFC

## 5. The DIDRevisionProposal event

```yaml
event: DIDRevisionProposal
payload:
  proposalId: string                  # uuid
  scope: shard                        # MUST be 'shard'; platform proposals not generated
  shardId: string                     # which Soul DID
  field: string                       # JSON path; e.g., "soulPurpose.mission"
  currentValue: any
  proposedValue: any                  # PPA's best inferred revision
  identityClass: core | evolving      # determines approval path
  classification: healthy | unhealthy | ambiguous
  classificationEvidence:
    demandClusterICPMatchRate: float  # [0,1]; high = healthy signal source
    demandClusterChurnCorrelation: float  # [0,1]; high = validated loss signal
    dismissToEscalateRatio: float     # high dismiss low escalate = DID stale (healthy)
    coreDIDFieldsAffected: boolean    # true = potential pivot, more caution
  triggerEvidence:
    dismissSignals: integer           # count over trigger window
    escalateSignals: integer
    demandMisalignment: float         # [0,1]; SA gap between demand and field
    driftEvents: integer              # SoulDriftDetected events attributable
    triggerWindow: duration           # ISO-8601, e.g., P60D
  confidence: high | medium | low
  approvalPath: triad | pillarLead    # derived from identityClass
  expiresAt: timestamp                # 14 days from creation
  createdAt: timestamp
```

## 6. Trigger Conditions

A proposal is generated when ANY of the following hold for a given DID field:

| Condition | Threshold (default) | Window |
|---|---|---|
| Sustained dismiss count | ≥ 10 dismiss signals | last 60 days |
| Demand misalignment | SA gap > 0.3 sustained | 3 sprints |
| Drift events | ≥ 3 SoulDriftDetected events attributable to this field | indefinite |

Thresholds are configurable per deployment via `.ai-sdlc/calibration.yaml`. Configuration changes require Product Lead approval (logged as governance events; not DID changes).

The trigger evaluation runs at the end of each calibration aggregation cycle (per PPA v1.2's flywheel cadence). When multiple conditions fire for the same field, a single proposal is generated; the trigger evidence captures all triggering conditions.

## 7. Classification Logic

Classification is computed deterministically from the evidence package:

```
healthy:    icpMatchRate > 0.6
            AND NOT coreDIDFieldsAffected

unhealthy:  icpMatchRate < 0.3
            OR (coreDIDFieldsAffected AND dismissToEscalateRatio < 1.0)

ambiguous:  everything else
```

**Healthy drift** → proposal targets DID revision (catch up to legitimate evolution); approval path applies.

**Unhealthy drift** → proposal recommendation is *not* a DID revision; instead, recommends admission-threshold tightening or demand-source review. Generates a `SoulHealthDiagnostic` proposal rather than a `DIDRevisionProposal` payload.

**Ambiguous drift** → fires both proposal payloads, flagged for triad review with full evidence package; approval path is always `triad` regardless of identityClass.

## 8. Approval Routing

Routing depends on the field's `identityClass` (per PPA v1.2 direction; assumes RFC-0009 has adopted field-level identityClass):

| identityClass | Approval Path | Reviewers Required |
|---|---|---|
| `core` | `triad` | All three pillar leads (Product + Design + Engineering) |
| `evolving` | `pillarLead` | Owning pillar lead + one other pillar lead |
| (unset) | `triad` (default-tighten) | All three; default is the safer choice when class is undeclared |

For ambiguous classification: approval path forced to `triad` regardless of identityClass.

## 9. Proposal Lifetime

- 14-day expiry from creation (configurable)
- Expiry without resolution emits `DIDRevisionProposalExpired` event — operator alert, not silent dismissal
- Approval / rejection records reviewer + rationale + timestamp
- Approval triggers a follow-on issue in the configured tracker for the actual DID file edit (per RFC-0011 DoR + RFC-0024 emergent capture flows)

## 10. Single-Product Platform Behavior

For platforms without tessellation, the single DID IS the shard DID. The mechanism operates identically; the `shardId` field in the event payload is the single shard's identifier (or a sentinel like `default`).

The Shard-DID-only scope constraint has no practical effect on single-product platforms — there is no platform-level DID to exclude.

## 11. Composition with Existing Mechanisms

| Existing | Composition |
|---|---|
| **PPA v1.2 SoulDriftDetected** | Drift events feed `triggerEvidence.driftEvents`; proposal-classification consumes the same evidence package as drift-source attribution |
| **PPA v1.2 calibration flywheel** | Dismiss / accept / escalate / override signals feed `triggerEvidence.dismissSignals` etc. |
| **RFC-0030 Signal Ingestion Pipeline** | Demand cluster SA-resonance feeds `classificationEvidence.demandClusterICPMatchRate` and `demandClusterChurnCorrelation` |
| **RFC-0024 Emergent Issue Capture** | Approved proposals generate emergent-issue records targeting the DID-edit task |
| **RFC-0023 Operator TUI** | Proposals surface as decision-pending blockers in the Decisions pane |

## 12. Open Questions

### 12.1 Confidence calibration

The `confidence` field is `high | medium | low` but the inputs to confidence inference aren't fully specified. **Position**: confidence = function of (sample size of trigger evidence, classification clarity, identityClass). Concrete computation deferred to an implementation memo; this RFC requires only that confidence be reported.

### 12.2 Multi-field bundling

Should related field revisions be bundled into one proposal (e.g., if mission + experientialTargets both drift together)? **Position**: defer to v2; v1 is one-field-per-proposal. Bundling adds complexity to approval routing (which identityClass dominates? which pillar lead approves?) without clear v1 benefit.

### 12.3 Operator opt-out per field

Some fields may be operator-locked ("never auto-propose revisions to this") even when triggers fire. **Position**: yes — `.ai-sdlc/calibration.yaml` SHOULD support a `field:lockNoProposal` list. Proposal generation skips locked fields; operators can opt back in by removing the entry. This is a v1 must-have.

### 12.4 Cross-pillar coordination

When a healthy-drift proposal would update a Design-pillar-owned field (e.g., voiceRegister), should Product Authority be the proposer or the reviewer? **Position**: PPA generates the proposal regardless (the flywheel evidence belongs to PPA); Design Authority is the approving pillar lead per identityClass routing. PPA's proposal is data; Design's approval is authority. Same pattern for Engineering-pillar-owned fields.

### 12.5 Rejection learnings

When the triad rejects a proposal, what feedback flows back into the flywheel? **Position**: rejection rationale captured in calibration log; future trigger evaluations weight rejection-precedent into confidence. Implementation deferred but the flywheel hook is required.

## 13. Non-Goals (re-stated)

- Not a DID editor. Not a DID schema spec. Not a UX flow. Not retroactive. Not multi-DID coordination.

## 14. References

- **RFC-0005**: PPA framework spec
- **RFC-0008**: PPA Triad Integration (calibration flywheel + SoulDriftDetected)
- **RFC-0009**: Tessellated Design Intent Documents (DID schema target)
- **RFC-0011**: Definition-of-Ready Gate (emergent-issue downstream of approval)
- **RFC-0023**: Operator TUI (surface for proposal review)
- **RFC-0024**: Emergent Issue Capture + Triage (downstream of approval)
- **RFC-0029**: Product Pillar Architectural Vision (Principle 3 "DID as Canonical Soul Reference"; Principle 4 "The Soul Holds")
- **RFC-0030**: Signal Ingestion Pipeline (demand-cluster ICP-match + churn correlation evidence)

---

**End of RFC-0031.**
