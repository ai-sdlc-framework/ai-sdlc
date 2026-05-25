---
id: RFC-0031
title: Calibration-Driven DID Revision Proposal Mechanism
status: Implemented
lifecycle: Implemented
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-16
targetSpecVersion: v1alpha1
# AISDLC-311 audit (2026-05-24): re-classified from `requires:` to `assumes:`.
# `orchestrator/src/sa-scoring/revision-proposal.ts` only imports `crypto.randomUUID`
# from Node stdlib — no actual code imports from any of these dependencies'
# implementations. The relationship is design-contract (the DID schema shape
# from RFC-0009, the PPA semantics from RFC-0005 / RFC-0008) read by callers
# rather than imported by this RFC's code.
assumes:
  - RFC-0005
  - RFC-0008
  - RFC-0009
  - RFC-0029
  - RFC-0030
implementedBy:
  - orchestrator/src/sa-scoring/revision-proposal.ts
requiresDocs: []
---

# RFC-0031: Calibration-Driven DID Revision Proposal Mechanism

**Document type:** Normative
**Status:** Implemented v1.2 — `orchestrator/src/sa-scoring/revision-proposal.ts` shipped via AISDLC-271 / PR #476 (2026-05-13). **Operator audit 2026-05-16 (AISDLC-299)** walked through all 5 §12 OQs that were resolved inline by the dev subagent during AISDLC-271 (without operator walkthrough — same governance pattern as PR #481 / RFC-0025; see [`docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md`](../../docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md)). Audit outcome: **not a revert candidate** — shipped code is operator-aligned at the foundation. OQ-12.2 + OQ-12.3 + OQ-12.4 affirmed unchanged; OQ-12.1 + OQ-12.5 get per-org config exposure (Refit **AISDLC-310**; default to shipped values). §12.6 added consolidating the per-org `calibration.yaml` schema.
**Lifecycle:** Implemented
**Updated:** 2026-05-16
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
| v1.1 | 2026-05-13 | AISDLC-271 subagent (no operator walkthrough) | Implementation shipped via PR #476. `revision-proposal.ts` with `evaluateRevisionProposal()`, `classifyDrift()`, `deriveApprovalPath()`, 14-day expiry + `DIDRevisionProposalExpired` event, `lockNoProposal` opt-out, `recordRejection()` + `computeRejectionPrecedentFactor()`. All 5 §12 OQs resolved inline by the subagent with concrete specifics Alex left for "implementation memo." Lifecycle flipped to Implemented. |
| v1.2 | 2026-05-16 | dominique@reliablegenius.io | Operator audit (AISDLC-299) walked through each §12 OQ. **Not a revert candidate** — shipped code is operator-aligned at the foundation. OQ-12.2 + OQ-12.3 + OQ-12.4 affirmed unchanged. OQ-12.1 + OQ-12.5 get per-org config exposure (Refit AISDLC-310; default to shipped values). §12 rewritten to preserve original question + first-pass + resolution per OQ (subagent had wholesale-overwritten the questions, same governance pattern as PR #481 / RFC-0025; documented in `docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md`). §12.6 added consolidating the per-org calibration.yaml schema. Initial audit pass mis-framed OQ-12.4 shipped behavior as "uniform 2-approver" and filed AISDLC-309 to revise; user-prompted re-read of `deriveApprovalPath()` while investigating the RFC-0009 dependency revealed the shipped code already graduates via §8 routing (`core` → triad/3-approvers; `evolving` → pillarLead/2-approvers) — AISDLC-309 retracted (deleted). |

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

## 12. Open Questions — resolved (initial 2026-05-13 subagent-inline; operator audit 2026-05-16)

> **Implementation Status (2026-05-13 / audit 2026-05-16):** `DIDRevisionProposal` mechanism shipped via AISDLC-271 / PR #476 on 2026-05-13. All 5 §12 OQs were resolved inline by the dev subagent during implementation, **without operator walkthrough** — same governance pattern as PR #481 / RFC-0025 (see [`docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md`](../../docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md) for the full root-cause analysis). The operator audit (AISDLC-299, 2026-05-16) walked through each OQ. Outcome: shipped code is operator-aligned at the foundation; OQ-12.2 + OQ-12.3 + OQ-12.4 affirmed unchanged; OQ-12.1 + OQ-12.5 get per-org config exposure as additive refinement (Refit AISDLC-310). **Not a revert candidate.** (OQ-12.4 was initially audited as "revised" based on a misread of shipped behavior — `deriveApprovalPath()` already graduates by `identityClass` per §8 routing: `core` → `triad` (3 approvers), `evolving` → `pillarLead` (2 approvers). Re-audit confirmed the shipped graduation matches operator intent; AISDLC-309 retracted.)
>
> **What ships:**
> - `orchestrator/src/sa-scoring/drift-monitor.ts` — `SoulDriftDetected` event (the §2.1 trigger source). Exported from `orchestrator/src/index.ts`.
> - `orchestrator/src/sa-scoring/feedback-store.ts`, `calibration.ts`, `auto-calibrate.ts` — flywheel substrate.
> - `orchestrator/src/sa-scoring/revision-proposal.ts` — `DIDRevisionProposal` event, drift classification (§3), approval routing (§4), 14-day expiry + `DIDRevisionProposalExpired` event (§5), `lockNoProposal` opt-out (OQ-12.3), rejection learnings via `ProposalRejectionRecord` + `computeRejectionPrecedentFactor` (OQ-12.5).
>
> The Resolution markers below preserve **both** the original Position (Alex, 2026-05-13), the subagent's first-pass concrete spec (shipped in PR #476), and the operator audit decision (2026-05-16). Where the audit affirmed the shipped spec, the marker says "operator-affirmed."

### 12.1 Confidence calibration

The `confidence` field is `high | medium | low` but the inputs to confidence inference aren't fully specified. **Position (Alex, 2026-05-13)**: confidence = function of (sample size of trigger evidence, classification clarity, identityClass). Concrete computation deferred to an implementation memo; this RFC requires only that confidence be reported.

   **First-pass (AISDLC-271 subagent, 2026-05-13):** `high` — sample size ≥ 20 AND classification ≠ `ambiguous` AND identityClass = `evolving`. `low` — sample size < 5 OR classification = `ambiguous` OR identityClass = `core`. `medium` — everything else. Sample size = `dismissSignals + escalateSignals + driftEvents`. Implemented in `computeConfidence()`.

   **Resolution (operator audit, 2026-05-16):** **Per-org configurable; defaults to shipped (≥20 / <5 thresholds).** Operator-affirmed the subagent's specific thresholds as the shipping default but adds `confidenceThresholds` section to `.ai-sdlc/calibration.yaml` (see §12.6) so operators with different SOUL-drift cadences can tune. Composes with the per-org configurability convention adopted across RFC-0024 / RFC-0025 / RFC-0035 during the 2026-05-15/16 walkthroughs. **Refit task:** [[AISDLC-310]] expose `confidenceThresholds` in calibration.yaml; no change to default behavior.

### 12.2 Multi-field bundling

Should related field revisions be bundled into one proposal (e.g., if mission + experientialTargets both drift together)? **Position (Alex, 2026-05-13)**: defer to v2; v1 is one-field-per-proposal. Bundling adds complexity to approval routing (which identityClass dominates? which pillar lead approves?) without clear v1 benefit.

   **First-pass (AISDLC-271 subagent, 2026-05-13):** v1 one-field-per-proposal; v2 can introduce `ProposalBundle`. Each field evaluated and proposed independently; callers wanting cross-field correlation compose multiple calls.

   **Resolution (operator audit, 2026-05-16):** **Operator-affirmed — shipped matches Alex's position exactly.** No code change. v1 = one-field-per-proposal; future `ProposalBundle` concept unbound by today's spec.

### 12.3 Operator opt-out per field

Some fields may be operator-locked ("never auto-propose revisions to this") even when triggers fire. **Position (Alex, 2026-05-13)**: yes — `.ai-sdlc/calibration.yaml` SHOULD support a `field:lockNoProposal` list. Proposal generation skips locked fields; operators can opt back in by removing the entry. This is a v1 must-have.

   **First-pass (AISDLC-271 subagent, 2026-05-13):** `lockNoProposal` list of JSON-path field identifiers in `.ai-sdlc/calibration.yaml`. Returns `{ kind: 'skipped', reason: 'locked' }`. `isFieldLocked()` + `CalibrationLockConfig` in `revision-proposal.ts`. `evaluateRevisionProposal()` checks lock before trigger evaluation (lock-precedes-trigger precedence).

   **Resolution (operator audit, 2026-05-16):** **Operator-affirmed.** JSON-path identifier syntax is industry-aligned (jq, gjson convention); lock-precedes-trigger matches the AWS IAM / OpenPolicyAgent Deny-precedes-Allow pattern. No code change.

### 12.4 Cross-pillar coordination

When a healthy-drift proposal would update a Design-pillar-owned field (e.g., voiceRegister), should Product Authority be the proposer or the reviewer? **Position (Alex, 2026-05-13)**: PPA generates the proposal regardless (the flywheel evidence belongs to PPA); Design Authority is the approving pillar lead per identityClass routing. PPA's proposal is data; Design's approval is authority. Same pattern for Engineering-pillar-owned fields.

   **First-pass (AISDLC-271 subagent, 2026-05-13):** PPA generates; owning pillar lead approves per `identityClass`. `approvalPath` is graduated by §8 routing: `core` → `triad` (3 approvers — all three pillar leads), `evolving` → `pillarLead` (2 approvers — owning lead + one other). The "owning lead + one other" definition scopes what the `pillarLead` path means; not a uniform behavior. Implemented in `deriveApprovalPath()`.

   **Resolution (operator audit, 2026-05-16):** **Operator-affirmed.** Shipped code already graduates by `identityClass` per §8 routing (`core` → 3 approvers via triad path; `evolving` → 2 approvers via pillarLead path). This matches industry patterns (GitHub branch protection / AWS IAM / k8s admission all graduate approver-count by stakes) and operator intent. Initial audit pass mis-framed shipped behavior as "uniform 2-approver" and filed AISDLC-309 to revise; re-audit on 2026-05-16 corrected the misread — **AISDLC-309 retracted, no code change.**

### 12.5 Rejection learnings

When the triad rejects a proposal, what feedback flows back into the flywheel? **Position (Alex, 2026-05-13)**: rejection rationale captured in calibration log; future trigger evaluations weight rejection-precedent into confidence. Implementation deferred but the flywheel hook is required.

   **First-pass (AISDLC-271 subagent, 2026-05-13):** `recordRejection()` captures rationale + `rejectionPrecedentWeight` (**0.8** high-conf / **0.5** medium / **0.2** low). Stored in `ProposalRejectionRecord`. Future evaluations call `computeRejectionPrecedentFactor(field, rejections)` → factor in `[0.2, 1.0]`. Formula: `factor = max(0.2, 1.0 - avgWeight × 0.5)`. Flat mean over all rejections (no recency weighting).

   **Resolution (operator audit, 2026-05-16):** **Per-org configurable; defaults to shipped (0.8/0.5/0.2 weights; flat mean; floor 0.2).** Operator-affirmed the subagent's specific weights as the shipping default; adds `rejectionWeights` section to `.ai-sdlc/calibration.yaml` (see §12.6). **Known future gap:** the flat-mean computation has no recency weighting — a year-old rejection suppresses legitimate current drift indefinitely. Per-org config addresses the gap as v1 escape hatch; a future v2 task (not in scope here) can introduce exponential decay over rejection age. **Refit task:** bundled into [[AISDLC-310]] alongside OQ-12.1's confidence threshold config exposure.

### 12.6 Configuration Schema (per-org defaults)

Audit decision: per-org configurability is added for OQ-12.1 (confidence thresholds) and OQ-12.5 (rejection weights/formula). OQ-12.4 approval routing is already graduated by `identityClass` per §8 (shipped behavior, operator-affirmed — no config exposure needed). The existing `.ai-sdlc/calibration.yaml` from OQ-12.3 is extended:

```yaml
calibration:
  lockNoProposal:                    # OQ-12.3 — existing, shipped
    - $.identityClass.evolving.foo
    - $.identityClass.core.bar

  confidenceThresholds:              # OQ-12.1 — NEW per-org (Refit AISDLC-310)
    highSampleSize: 20               # default; raise to be more conservative
    lowSampleSize: 5                 # default; lower to be more sensitive

  rejectionPrecedent:                # OQ-12.5 — NEW per-org (Refit AISDLC-310)
    weights:
      highConfidenceRejection: 0.8
      mediumConfidenceRejection: 0.5
      lowConfidenceRejection: 0.2
    confidencePenaltyFloor: 0.2      # max suppression factor; 0.2 = at most 80% suppression
    formula: "max(floor, 1.0 - avgWeight × 0.5)"   # flat-mean formula; v2 may add recency decay
```

Default constants ship in the `ai-sdlc init` calibration template. Operator-configurable from day one of each refit task landing. Auto-tuning from observed flywheel data is future work (composes with RFC-0035 calibration loop).

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
