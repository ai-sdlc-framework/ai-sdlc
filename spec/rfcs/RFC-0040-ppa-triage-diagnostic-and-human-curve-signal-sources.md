---
id: RFC-0040
title: PPA Triage Diagnostic + Human Curve Signal Sources for Adopter Bootstrap
status: Draft
lifecycle: Draft
author: alexanderkline13@gmail.com
created: 2026-05-19
updated: 2026-05-19
targetSpecVersion: v1alpha1
requires: [RFC-0005, RFC-0008]
relatedRFCs: [RFC-0037, RFC-0038, RFC-0039]
requiresDocs: []
---

# RFC-0040: PPA Triage Diagnostic + Human Curve Signal Sources for Adopter Bootstrap

**Status:** Draft
**Lifecycle:** Draft
**Author:** alexanderkline13@gmail.com (Product owner contribution)
**Created:** 2026-05-19
**Updated:** 2026-05-19
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io
- [ ] Product owner — Alexander Kline

## 1. Summary

When an adopter project first wires up PPA (RFC-0005), most input signals default to uniform values until adapter configurations (SupportChannel / CrmProvider / AnalyticsProvider) are wired AND a baseline of explicit-priority + decision-record signals accumulate. The result: composite scores cluster tightly across all candidate work items, and `/ai-sdlc triage` produces a **directionally correct but stack-rank-imprecise** signal during the bootstrap phase.

This RFC proposes two complementary additions:

1. **A diagnostic mode for `cli-admit` / `/ai-sdlc triage`** that surfaces *which* dimensions are at default values, *why* the variance is narrow, and *what* signal sources the adopter could enrich. Today's failure mode is silent — the operator gets a score without knowing the score is degraded.

2. **A canonical signal-source contract for Human Curve (HC)** — explicit documentation + adapter contract for the four HC sub-signals named in RFC-0005 §2 (`explicit` / `consensus` / `decision` / `design`). Adopters who use Backlog.md priority labels OR comment-thread voting OR meeting-minutes decision records reasonably expect those signals to surface in HC; today the mapping isn't standardized + the Backlog adapter doesn't perform it.

## 2. Motivation

### Observed adopter pain — bootstrap-stage triage degradation

A production adopter ran `cli-admit --tracker backlog` across 13 open P0/P1 tickets after a bug-investigation session. Expected: the explicit-priority labels (`p0` / `p1`) + the operator's session-time triage flagging should bias HC, surfacing the recently-identified production-bug tickets above pre-existing infrastructure-class work.

Observed: **HC = 0 across all 13 tickets.** Soul Alignment was uniform at 0.60. Demand Pressure was narrow (0.38–0.40). Composite scores clustered in [0.0864, 0.2160] with the top score going to an umbrella task already substantially complete, while the actual production-bug tickets — which the operator had been verbally + label-flagging as urgent — landed in the middle of the pack.

The PPA algorithm did what it was specified to do. The adapter contract simply didn't carry the explicit-priority + operator-decision signals into HC, and there was no diagnostic indicating which dimensions were at default values.

### Why this matters for the bootstrap phase

The adoption ladder for PPA is naturally long:
- Day 1: adopter configures `priorityPolicy` + `soulPurpose`. All 5 dimensions start at defaults.
- Week 1-4: adopter integrates SupportChannel / CRM / Analytics adapters as their tooling permits.
- Month 1-3: outcome-feedback history accumulates → Cκ becomes meaningfully informed.
- Month 3+: full calibration.

During Days 1 through Month 3, the adopter has a **functional triage** but the scores are systematically uninformative for stack-ranking. Without diagnostics, the adopter cannot tell whether "score 0.115" means "actually moderate priority" or "PPA running on defaults — this means nothing relative to other 0.115 items." The adopter is silently led to either (a) trust the rank-ordering more than it deserves, or (b) lose confidence in PPA entirely.

### Why HC specifically deserves the canonical signal-source contract

Of the 5 dimensions, HC is the only one that:
- Has an *explicit* sub-signal (`explicit`) the operator directly controls via labels/markers
- Has a *consensus* sub-signal that's naturally derivable from comment threads / reactions
- Has a *decision* sub-signal explicitly tied to meeting minutes / decision records
- Has a *design* sub-signal the design pillar (RFC-0008) governs

The other dimensions depend on adapters (DP) or content semantics (SA, Eρ, Eτ) that require richer integration. HC's signal sources are *already present in adopters' day-to-day artifacts* — they just need a standardized mapping that the Backlog adapter (and the GitHub adapter) can apply uniformly.

## 3. Goals + Non-Goals

### Goals

- `cli-admit` (and `/ai-sdlc triage`) accepts a `--diagnose` flag that emits per-dimension diagnostic output: which value is default, which is signal-derived, which signal sources were attempted, which sources are missing
- A `--report-batch` mode that takes N candidate work items and reports the bootstrap maturity of the *batch* (e.g., "11 of 13 tickets had HC = 0; this typically indicates explicit-priority labels aren't mapped to HC explicit")
- Canonical signal-source mapping for HC sub-signals documented in RFC-0005's adapter docs section (or as an addendum)
- Backlog adapter updated to read `priority:p*` / `priority-explicit:*` labels (or equivalent canonical form) and route them to `HC.explicit`
- Doc — "Bootstrap-stage triage interpretation guide" — adopter-facing, explains how to read scores when most dimensions are at defaults

### Non-Goals

- Redefining PPA's algorithm or formula (RFC-0005 is unchanged)
- Auto-calibration shortcuts (Cκ-acceleration via synthetic data) — that's a different RFC
- Adapter implementation specifics for non-Backlog/non-GitHub trackers — they can adopt the same contract independently

## 4. Proposed Mechanism

### 4.1 `--diagnose` flag (cli-admit + `/ai-sdlc triage`)

Output JSON adds a `diagnostics` block:

```json
{
  "admitted": true,
  "score": { ... },
  "diagnostics": {
    "bootstrapTier": 0,
    "dimensionDefaults": {
      "Sα": { "value": 0.60, "isDefault": true, "reason": "no semantic-distance backend configured; using flat default" },
      "Dπ": { "value": 0.40, "isDefault": true, "reason": "no SupportChannel/CrmProvider/AnalyticsProvider adapter; using 0.4 default" },
      "Mφ": { "value": 1.00, "isDefault": true, "reason": "no market-signal adapter configured" },
      "Eρ": { "value": 0.66, "isDefault": false, "reason": "derived from complexity score = 4" },
      "Eτ": { "value": 0.00, "isDefault": true, "reason": "no Entropy Tax sources configured" },
      "HC": { "value": 0.00, "isDefault": true, "reason": "explicit signal: 0 sources mapped (labels not bound to HC); consensus: 0 sources; decision: 0 sources" },
      "Cκ": { "value": 1.00, "isDefault": true, "reason": "no calibration history (< 30 outcomes recorded)" }
    },
    "signalCoverage": "1 of 7 dimensions has non-default input (Eρ via complexity)",
    "recommendation": "Score variance across this batch is likely dominated by Execution Reality. To increase signal: (a) bind priority labels to HC.explicit, (b) configure at least one DP adapter, (c) accumulate calibration history."
  }
}
```

### 4.2 `--report-batch` mode

Accepts a file of task-ids; outputs a per-batch diagnostic:

```
PPA Batch Diagnostic Report
N = 13 candidate items

Default-value rate per dimension:
  Sα: 13/13 at default (1.0) — no SA differentiation across batch
  Dπ: 13/13 at default narrow band (0.38-0.40)
  Mφ: 13/13 at default (1.00)
  Eρ: 0/13 at default — complexity is the only differentiating signal
  Eτ: 13/13 at default
  HC: 13/13 at HC = 0 — explicit-priority labels did NOT map to HC
  Cκ: 13/13 at 1.00 — no outcome history yet

Composite score variance: 0.0864 to 0.2160 (range 0.130)
  Variance source: Execution Reality alone

Bootstrap tier: 0 (out-of-box defaults dominate)
Highest-leverage enrichment: map adopter priority labels to HC.explicit + configure 1 DP adapter
```

### 4.3 Canonical HC signal-source contract

Document — likely as RFC-0005 Addendum C or a new doc — covering:

- **HC.explicit**: how adopter-applied priority labels (`p0`/`p1`/`priority:p0`/etc.) map to the explicit weight. Default mapping: `p0 → 1.0`, `p1 → 0.7`, `p2 → 0.4`, `p3 → 0.1`, unlabeled `→ 0.0`. Adopter can override via `priorityPolicy.dimensions.humanCurve.explicitLabelMapping`.
- **HC.consensus**: how comment-thread reactions / +1s map to consensus weight. Default: `count(👍 + ❤️ + 🚀) / max(team-size, 5)`, capped at 1.0.
- **HC.decision**: how linked decision records (`backlog/decisions/decision-XXX.md` or GitHub issue body `Closes/Implements/Resolves` referencing ADR-NNN) map to decision weight. Default: presence of linked decision = 1.0, else 0.0.
- **HC.design**: per RFC-0008 — Design pillar's design-authority signal. Adopters without a design layer can leave at 0.

### 4.4 Backlog adapter HC mapping (implementation)

The Backlog adapter reads frontmatter `labels:` array + relevant comment thread metadata + linked decision-record references. Apply the canonical mapping above unless `priorityPolicy.dimensions.humanCurve` overrides. Adopters using non-default label conventions (e.g., `priority:high` instead of `p0`) override via config; defaults work for typical Backlog.md projects.

## 5. Backward Compatibility

Fully backward-compatible:
- `--diagnose` and `--report-batch` are new flags — existing callers see no behavior change.
- Adapter HC mapping is **additive** — adopters who don't ship priority labels keep HC = 0. The default mappings activate only when labels matching the canonical form are present.

## 6. Composition with Other RFCs

- **RFC-0005 (PPA)**: this RFC adds diagnostics + adapter signal sources WITHOUT modifying the multiplicative formula or dimension definitions
- **RFC-0008 (PPA Triad Integration)**: HC.design sub-signal directly serves RFC-0008's Design pillar (`d-authority` directional flow)
- **RFC-0037 (Adopter Project Context)**: adopter-context file is a natural place for adopters to document their priority-label conventions when they differ from the canonical mapping
- **RFC-0038 (Adopter-Defined Reviewers)**: an adopter-defined `priority-trace-reviewer` could surface HC signal coverage in PR-time review findings
- **RFC-0039 (Adopter-Defined Pipeline Gates)**: a `priority-floor` gate could refuse dispatch when HC-derived rank doesn't meet a project's threshold

## 7. Alternatives Considered

### 7.1 Status quo: adopters self-diagnose

Today, an adopter can manually inspect cli-admit JSON output, notice values are uniform, and infer the bootstrap-tier limitation. This is what tonight's adopter session did. It works but requires the adopter to *already know* PPA's mechanics deeply. The framework should surface diagnostics natively.

### 7.2 Refuse to score during bootstrap

Refuse to admit any work item until at least N dimensions have non-default values. Too aggressive — Day-1 adopters need *some* signal even if it's complexity-only. Diagnostic output is the right answer; refusal would be a UX regression.

### 7.3 Calibration shortcuts (synthetic history seeding)

Seed Cκ with synthetic outcomes derived from project archaeology (historical issue resolution rates, PR cycle times, etc.). Heavier engineering, addresses a different problem (Cκ specifically). Worth a future RFC; out of scope here.

## 8. Open Questions

1. **Canonical label form**: should the default HC.explicit mapping use `p0`/`p1`/`p2`/`p3` (Backlog.md convention) or `priority/p0`-style (GitHub convention) or both? Adapter-specific defaults vs. universal default-set.
2. **Diagnostic verbosity**: should `--diagnose` be on by default in `/ai-sdlc triage` (operator-friendly) or opt-in (clean JSON for tooling)? Probably default-on for human callers, opt-out via `--no-diagnose` for tooling.
3. **Batch report scope**: should `--report-batch` accept arbitrary task-id lists, or only well-defined batches like "all open P0/P1" or "current sprint"? Probably accept any list; let the operator define the batch.
4. **HC label-mapping discoverability**: should the adopter onboarding flow include a "verify your priority labels map to HC" check, surfaced via `/ai-sdlc init-signing-key`-style one-time skill? Or via a separate `/ai-sdlc bootstrap-check` skill?

## 9. References

- RFC-0005 Product Priority Algorithm (PPA) — the algorithm this RFC adds diagnostics to
- RFC-0008 PPA Triad Integration — the cross-pillar signal flows that HC composes with
- RFC-0037 Adopter Project Context Inheritance — natural home for adopter-specific label-mapping overrides
- RFC-0038 Adopter-Defined Reviewer Extension Point — composes with a future priority-trace-reviewer
- RFC-0039 Adopter-Defined Pipeline Gate Extension — composes with priority-floor / entropy-tax-budget gates
- cli-admit current implementation: `dogfood/src/cli-admit.ts`, `dogfood/src/admit-backlog.ts` (where the Backlog adapter mapping would land)
