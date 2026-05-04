---
id: RFC-0032
title: Cost-Governance Seam (Continuous ER Cost Pressure + Burst Spend Mechanism)
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0004
  - RFC-0005
  - RFC-0008
  - RFC-0009
  - RFC-0010
  - RFC-0029
requiresDocs: []
---

# RFC-0032: Cost-Governance Seam — Continuous ER Cost Pressure + Burst Spend Mechanism

**Document type:** Normative (draft)
**Status:** Draft v1 — Initial proposal. Resolves the placement-divergence between RFC-0009 §7.4 OQ-12 (HC_cost as HC channel) and the PPA-side position (cost-pressure as Execution-axis property). Adds continuous `ER_cost_effort` modifier alongside the categorical ER6 gate; specifies a burst-spend mechanism with dual-approval and executive-tiebreak escalation.
**Lifecycle:** Draft
**Authors:** Alexander Kline (Head of Product Strategy / Product Authority; PPA v1.0/v1.1 author)
**Requires:** RFC-0004 (Cost Governance + Attribution), RFC-0005 (PPA), RFC-0008 (PPA Triad Integration; ER6 + HC), RFC-0009 (Tessellated DIDs; §7.4 HC_cost OQ-12 resolution), RFC-0010 (Parallel Execution; SubscriptionLedger + tenantQuotaShare), RFC-0029 (Product Pillar Architectural Vision — Principle 1 three-axis basis; Principle 6 executive layer)

> The bold-style status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

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
| v1 | 2026-05-04 | Alexander | Initial draft. Resolves the cost-pressure placement question by formalizing `ER_cost_effort` as a continuous Execution-axis modifier (sitting alongside categorical ER6). Defines `BurstSpendRequest` event with composite-score gating (≥0.8) + dual-approval (Product + Operator) + executive-tiebreak escalation + 4-hour timeout. Single-product platforms use pipeline `costBudget` (RFC-0004) instead of `tenantQuotaShare`. |

---

## 1. Summary

PPA v1.1 introduced ER6 (Cost Clearance) as a **categorical** gate in the Execution Reality min-aggregation: when a shard's quota share is exhausted, ER6 = 0.0 and the work cannot dispatch. This handles the binary case (can we afford this at all?) but not the gradient case (what about work that *can* dispatch but is expensive enough to deserve deprioritization vs cheaper alternatives?).

RFC-0009 §7.4 (OQ-12 resolution) placed `HC_cost` as a Human Curve channel — a soft cost-pressure lever the operator tunes. This is **structurally inconsistent with the PPA composite's three-axis basis** (per RFC-0029 Principle 1): cost is an Execution-axis property (can we afford to build this *right now*?), not a Human Curve property (does someone think this is important?).

This RFC resolves the seam by:

1. Defining a continuous `ER_cost_effort` modifier on the composite, sitting **alongside** the categorical ER6 gate (not within the min-aggregation)
2. Specifying `BurstSpendRequest` — a governed mechanism for high-priority work to request resources beyond normal budget boundaries, with dual-approval (Product + Operator) and executive-tiebreak escalation when they disagree
3. Documenting the boundary between RFC-0009 §7.4 HC_cost (operator tuning lever, soft) and `ER_cost_effort` (composite scoring modifier, continuous)

The burst mechanism is the framework's first concrete interface to the executive layer (per RFC-0029 Principle 6) — when Product and Operator disagree on spend, the decision elevates above both.

## 2. Motivation

### 2.1 ER6 categorical gate alone is insufficient

ER6's min-aggregation sets the score to 0.0 when quota is exhausted. That's correct for the hard case. But the gradient between "comfortable headroom" and "quota exhausted" is invisible to PPA.

Concretely: a 500K-token Opus task and a 50K-token Haiku task that *both* fit within remaining quota score identically on ER6 (both pass the categorical gate). PPA can't say "this expensive task is acceptable but the cheaper task is preferable when both score equally on identity / demand / market." The composite needs to express **cost gradient**, not just cost categorical.

### 2.2 RFC-0009 §7.4 HC_cost violates the three-axis basis

Per RFC-0029 Principle 1, the framework's three orthogonal axes of authorship are:

- **Identity** (Product) — what the product IS; SA, D, M, ET dimensions
- **Expression** (Design) — how it APPEARS; SA2, ER4
- **Execution** (Engineering) — coherence at runtime; ER1-3, ER5, ER6, CK

Cost is fundamentally an **Execution constraint**: "can we afford to build this right now?" is the question ER answers (resources, complexity, dependencies, design system, compliance, cost). It is not "does someone think this is important?" (HC).

Placing HC_cost as a Human Curve channel breaks the basis: it conflates structural authority (Engineering's enforcement function) with intent declaration (HC's "human says X matters"). HC's existing components (Override, consensus, decision, design-authority, product-authority) are all *intent* signals; cost-pressure is a *constraint*, not an intent.

This RFC corrects the placement: continuous cost-pressure → ER (Execution-axis modifier). RFC-0009 §7.4's HC_cost stays as a name only insofar as it survives the realignment; the *mechanism* moves to ER.

### 2.3 The framework lacks a governed burst-spend mechanism

When genuinely high-priority work (composite ≥ 0.8) would push past normal budget, today the operator either:

- Lets ER6 fire and the work is silently deprioritized to zero (correct gate, wrong UX — no signal to the operator that high-value work is being blocked by cost)
- Manually overrides the budget (no audit trail, no dual-control)

Neither matches the framework's governance posture. A structured burst-spend mechanism with explicit approval requirements and audit logging makes the cost-vs-value tradeoff a first-class decision, not a side effect.

### 2.4 Product / Operator disagreement on spend is structurally executive

When Product Authority says "this work is strategically critical, spend the burst" and Operator says "the budget can't accommodate that without sacrificing other shards' work," **neither pillar wins**. The decision elevates above both because it's fundamentally an executive function (cost posture, budget allocation, cross-shard tradeoffs).

This is the framework's first concrete interface to the executive layer per RFC-0029 Principle 6 (executive layer above, not within the triad). The burst mechanism's `onDisagreement: escalate-to-executive` makes that interface real.

## 3. Goals

1. **Continuous cost-pressure expression in the composite** — `ER_cost_effort` modifier on the composite, distinct from the categorical ER6 gate
2. **Bounded modifier values** — `[0.5, 1.0]` range (cost pressure can deprioritize but not zero a task; that's ER6's job)
3. **Burst-spend mechanism** — `BurstSpendRequest` event with composite-score gating (≥0.8) + cost-pressure threshold (`ER_cost_effort < 0.5`)
4. **Dual-approval governance** — Product Authority (strategic justification) + Operator (budget feasibility); neither can unilaterally approve
5. **Executive-tiebreak escalation** — disagreement elevates to executive layer; 4-hour timeout auto-declines
6. **Single-product platform support** — same mechanism operates against pipeline `costBudget` (RFC-0004) instead of per-shard `tenantQuotaShare` (RFC-0010)
7. **Audit trail** — all burst requests logged with composite score, justification, approval/denial path, executive ruling if applicable

## 4. Non-Goals

1. **Not a replacement for ER6** — ER6 categorical gate stays. `ER_cost_effort` is gradient-aware, not zero-aware
2. **Not a budget management tool** — the framework records the burst; quota allocation lives with RFC-0010 SubscriptionLedger / RFC-0004 cost governance
3. **Not retroactive** — burst requests apply forward-looking; previously-completed expensive work is not re-priced
4. **Not a tool for operator-side cost optimization** — adopters can still tune subscription tiers and per-stage model routing per RFC-0010; this RFC adds composite-level expression on top
5. **Not a centralized billing system** — adopters' cost realities (subscription windows, off-peak multipliers, monthly caps) are captured by RFC-0010 + RFC-0004; this RFC consumes their output

## 5. ER_cost_effort Modifier

### 5.1 Computation

```
estimated_cost(w) = Σ over stages: stage.estimatedTokens × stage.modelUnitCost
shard_budget_remaining(s) = s.tenantQuotaShare × window_remaining - current_burn

ER_cost_effort(w, s):
  If estimated_cost(w) ≤ 0.3 × shard_budget_remaining(s):
    1.0    // comfortable headroom, no pressure
  Else if estimated_cost(w) ≤ 0.7 × shard_budget_remaining(s):
    0.8    // moderate pressure
  Else if estimated_cost(w) ≤ shard_budget_remaining(s):
    0.5    // high pressure, still feasible
  Else:
    // ER6 fires (categorical gate, 0.0)
```

### 5.2 Application to composite

`ER_cost_effort` is **NOT** a new ER sub-component in the `min(ER1..ER6)` aggregation. It is a multiplicative modifier applied **after** the main composite is computed:

```
P(w, s) = SA × D × M × ER × (1-ET) × (1+HC) × CK     // unchanged
P_adjusted(w, s) = P(w, s) × ER_cost_effort(w, s)    // new
```

Sort order in admission queue uses `P_adjusted`. Items under cost pressure score lower, but cannot drop below 0.5× their pre-modifier score. ER6's categorical gate remains the hard zero.

### 5.3 Single-product platforms

Platforms without tessellation (no `tenantQuotaShare`) substitute the pipeline-level `costBudget` from RFC-0004:

```
budget_remaining = pipeline.costBudget - current_burn
```

The thresholds (0.3, 0.7, 1.0) apply identically.

## 6. BurstSpendRequest Event

### 6.1 Schema

```yaml
event: BurstSpendRequest
payload:
  requestId: string                  # uuid
  workItemId: string
  shardId: string                    # or pipeline-id for single-product
  compositeScore: float              # P_adjusted at time of request
  estimatedAdditionalCost: float
  currentBurn: float
  budgetRemaining: float
  justification: string              # from PPA pillar perspective breakdown
  requestedTtl: duration             # how long the burst should remain in effect
  trigger:
    compositeScore: ">= 0.8"
    erCostEffort: "< 0.5"
  approval:
    required: true
    approvers: [product-authority, operator]
    onDisagreement: escalate-to-executive
    timeout: PT4H                    # 4-hour auto-decline if unresolved
    effect: temporary tenantQuotaShare increase OR pipeline costBudget extension
  status: pending | approved | denied | expired | escalated | executive-resolved
  createdAt: timestamp
  resolvedAt: timestamp
  resolvedBy: string                 # email or role identifier
```

### 6.2 Trigger conditions (both must hold)

1. `P_adjusted(w, s) ≥ 0.8` — composite score reflects genuinely high-priority work
2. `ER_cost_effort(w, s) < 0.5` — only triggered when cost pressure is high enough that the modifier is reducing priority

The double-gate prevents spam from medium-priority items and from cheap items that don't need a burst.

### 6.3 Approval flow

```
BurstSpendRequest (pending)
  ├── Product Authority approves
  │     └── Operator approves → APPROVED, budget bump applied
  │     └── Operator denies   → ESCALATED to executive layer
  ├── Product Authority denies → DENIED (Operator bypass disallowed)
  ├── 4-hour timeout            → EXPIRED, work item remains in queue at P_adjusted
  └── Executive resolution      → EXECUTIVE-RESOLVED (approved or denied; rationale logged)
```

**Disagreement escalation**: when Product Authority approves but Operator denies (or vice versa), the request enters the `escalated` state. Resolution waits for the executive layer's ruling. The framework does not specify the executive layer's identity or cadence (per RFC-0029 Principle 6 — that is deferred); it specifies only the escalation event and that the work item is held in the queue at its `P_adjusted` score until the executive ruling lands.

### 6.4 4-hour timeout rationale

A burst request that lingers blocks queue progression. The 4-hour timeout balances:

- Enough time for Product + Operator to deliberate (not minutes)
- Short enough that an unresolved request doesn't stall high-priority work indefinitely
- Auto-decline (not auto-approve) is the safer default

When the timeout expires, the work item remains in the queue at its cost-pressure-discounted `P_adjusted` score until the next billing window resets `shard_budget_remaining` or a new burst request is filed.

## 7. Boundary with RFC-0009 §7.4 HC_cost

This RFC takes the position that **continuous cost-pressure belongs in ER**, not in HC. RFC-0009 §7.4 OQ-12's resolution placed `HC_cost` as an HC channel. This RFC proposes:

| Decision | Position |
|---|---|
| Continuous cost-pressure mechanism | Lives here as `ER_cost_effort` (Execution axis) |
| RFC-0009 §7.4 `HC_cost` semantic | If HC_cost is to remain as a name in the framework, it should be redefined as something distinct from cost-pressure scoring — perhaps as the **operator's discretionary cost-tuning lever** (a soft override on top of `ER_cost_effort`), or retired as a label |
| Net composite mechanism | One continuous cost-pressure expression in `ER_cost_effort`; one categorical gate in ER6; one escape hatch in `BurstSpendRequest` |

This is a placement-correction proposal. RFC-0009 maintainers have final say on the §7.4 disposition; this RFC argues the case from the three-axis basis (RFC-0029 Principle 1) and offers `ER_cost_effort` as the resolution.

## 8. Composition with RFC-0010 SubscriptionLedger

RFC-0010 §14 (SubscriptionLedger) tracks remaining quota across windows and supports per-stage `schedule` hints (off-peak deferral, current-quota requirement). This RFC consumes that data:

- `shard_budget_remaining(s) = s.tenantQuotaShare × window_remaining - current_burn` reads from the ledger
- Approved burst requests temporarily increase `s.tenantQuotaShare` for the burst's TTL
- The ledger records burst events as a new transaction kind (`burst-grant`)

This RFC adds a transaction kind to the ledger; it does not redefine the ledger's mechanism.

## 9. Composition with RFC-0023 Operator TUI

Burst requests surface in the operator TUI as **decision-pending blockers** — high-urgency entries because they auto-expire in 4 hours. The TUI MUST surface:

- Pending burst requests with composite score, cost ask, justification
- Disagreement state (Product approved, Operator pending; or both pending)
- Timer countdown to expiry / executive escalation

The TUI surfaces requests; this RFC defines the underlying event.

## 10. Open Questions

### 10.1 Executive layer identity

Per RFC-0029 Principle 6, the executive layer is "above the triad as context and constraint, not as a fourth pillar within it." But the burst mechanism needs a concrete contact point. **Position**: configurable per deployment (`.ai-sdlc/executive-escalation.yaml` with email + Slack channel + TTL). v1 ships with the configuration surface; identity is operator-specified.

### 10.2 Multi-shard burst contention

If two shards file simultaneous burst requests against a shared platform budget, who wins? **Position**: defer to v2; v1 first-come-first-served at the executive escalation point. Cross-shard arbitration is fundamentally an executive judgment call; the framework records evidence, executive decides.

### 10.3 Auto-approve thresholds

Should very-high-composite-score requests (e.g., ≥ 0.95) auto-approve without human gate? **Position**: NO. Cost decisions require human judgment regardless of composite score; auto-approve removes the dual-approval governance the mechanism exists to provide.

### 10.4 Burst-rejection learnings

When the executive layer denies a burst, what feedback flows into PPA? **Position**: rejection rationale flows into CK calibration as evidence that the composite over-weighted the work item; future similar work scores lower. Implementation deferred but the calibration hook is required.

### 10.5 Per-pillar cost-veto

Should any single pillar lead be able to veto a burst on cost grounds (vs the dual-approval requiring affirmative consent)? **Position**: NO; veto without dual-approval reintroduces the unilateral path the dual-approval is designed to prevent.

## 11. Non-goals (re-stated)

- Not a replacement for ER6. Not a budget management tool. Not retroactive. Not a centralized billing system. Not a cost-optimization recommender.

## 12. References

- **RFC-0004**: Cost Governance + Attribution (`pipeline.costBudget`)
- **RFC-0005**: PPA framework spec
- **RFC-0008**: PPA Triad Integration (ER + HC composite structure)
- **RFC-0009**: Tessellated Design Intent Documents (§7.4 HC_cost OQ-12 — the seam this RFC resolves)
- **RFC-0010**: Parallel Execution + Worktree Pooling (§14 SubscriptionLedger; tenantQuotaShare)
- **RFC-0023**: Operator TUI (decision-pending surface for burst requests)
- **RFC-0029**: Product Pillar Architectural Vision (Principle 1 three-axis basis; Principle 6 executive layer above the triad)

---

**End of RFC-0032.**
