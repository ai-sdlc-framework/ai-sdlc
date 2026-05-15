---
id: RFC-0031
title: Calibration-Driven DID Revision Proposal Mechanism
status: Implemented
lifecycle: Implemented
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-13
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

> **Implementation Status (2026-05-13):** All items shipped. `DIDRevisionProposal` mechanism implemented in `orchestrator/src/sa-scoring/revision-proposal.ts`; exported from `orchestrator/src/index.ts`. Lifecycle flipped to `Implemented`.
>
> **What ships:**
> - `orchestrator/src/sa-scoring/drift-monitor.ts` — `SoulDriftDetected` event (the §2.1 trigger source). Exported from `orchestrator/src/index.ts`.
> - `orchestrator/src/sa-scoring/feedback-store.ts`, `calibration.ts`, `auto-calibrate.ts` — flywheel substrate.
> - `orchestrator/src/sa-scoring/revision-proposal.ts` — `DIDRevisionProposal` event, drift classification (§3), approval routing (§4), 14-day expiry + `DIDRevisionProposalExpired` event (§5), `lockNoProposal` opt-out (OQ-12.3), rejection learnings flowing back via `ProposalRejectionRecord` + `computeRejectionPrecedentFactor` (OQ-12.5). OQs 12.1–12.5 resolved below.

The 5 OQs below have been resolved through the AISDLC-271 walkthrough. All answers are now normative.

### 12.1 Confidence calibration (RESOLVED)

**Normative answer:** `confidence = f(sample size, classification clarity, identityClass)`:

- `high` — sample size ≥ 20 AND classification ≠ `ambiguous` AND identityClass = `evolving`
- `low`  — sample size < 5 OR classification = `ambiguous` OR identityClass = `core` (higher-stakes fields default to low confidence)
- `medium` — everything else

Sample size is `dismissSignals + escalateSignals + driftEvents` from the trigger evidence window. This is implemented in `computeConfidence()` in `revision-proposal.ts`.

### 12.2 Multi-field bundling (RESOLVED — deferred to v2)

**Normative answer:** v1 is one-field-per-proposal. Multi-field bundling is explicitly out of scope for v1. Bundling would require resolving: which `identityClass` dominates when fields differ? Which pillar lead approves? Without clear answers these questions add complexity without v1 benefit. Each field is evaluated and proposed independently; callers wanting cross-field correlation must compose multiple calls. v2 can introduce a `ProposalBundle` concept when the cross-field scenarios are better understood.

### 12.3 Operator opt-out per field (RESOLVED — v1 must-have, shipped)

**Normative answer:** `.ai-sdlc/calibration.yaml` MUST support a `lockNoProposal` list of JSON-path field identifiers. Proposal generation skips locked fields; the function returns `{ kind: 'skipped', reason: 'locked' }`. Operators remove entries to opt back in. Implemented as `isFieldLocked()` + `CalibrationLockConfig` in `revision-proposal.ts`. The `evaluateRevisionProposal()` entry point accepts `lockConfig` and checks it before trigger evaluation (opt-out takes precedence over trigger state).

### 12.4 Cross-pillar coordination (RESOLVED)

**Normative answer:** PPA generates the proposal regardless of which pillar owns the drifted field. The flywheel evidence belongs to PPA. The owning pillar lead (Design for `voiceRegister`, Engineering for substrate fields, etc.) is the _approving_ authority per `identityClass` routing in §8, not the proposing authority. `approvalPath = pillarLead` means "owning pillar lead + one other pillar lead" — the owning lead is determined by the field's pillar in the DID schema, which is resolved by the caller at review time. PPA proposes data; pillar lead approves authority. Implemented in `deriveApprovalPath()`.

### 12.5 Rejection learnings (RESOLVED — flywheel hook shipped)

**Normative answer:** When a proposal is rejected, `recordRejection()` captures the rationale + a `rejectionPrecedentWeight` (0.8 for high-confidence rejections, 0.5 for medium, 0.2 for low). The weight is stored in a `ProposalRejectionRecord` in the calibration log. Future trigger evaluations for the same field should call `computeRejectionPrecedentFactor(field, rejections)` to get a factor in `[0.2, 1.0]` that penalises confidence proportionally: `factor = max(0.2, 1.0 - avgWeight × 0.5)`. High-confidence rejections produce a factor of 0.6, reducing future proposal confidence. Both functions are exported from `revision-proposal.ts`.

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
