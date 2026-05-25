---
id: RFC-0037
title: Cost-Gated Continuous Orchestrator Heartbeat
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-13
updated: 2026-05-13
targetSpecVersion: v1alpha1
requires: [RFC-0004, RFC-0011, RFC-0014, RFC-0015]
# Strategic + adopter-facing RFC. Operator runbook for the heartbeat lands at
# sign-off; intentionally empty at Draft stage.
requiresDocs: []
---

# RFC-0037: Cost-Gated Continuous Orchestrator Heartbeat

**Status:** Draft
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-13
**Updated:** 2026-05-13
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io
- [ ] Product owner — Alexander Kline
- [ ] Operator owner — dominique@reliablegenius.io

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [The Deterministic Preflight Predicate](#4-the-deterministic-preflight-predicate)
5. [The `/loop` Heartbeat Mechanism](#5-the-loop-heartbeat-mechanism)
6. [Cost-Rail Integration](#6-cost-rail-integration)
7. [Operator-Fatigue Gate](#7-operator-fatigue-gate)
8. [Calibration Loop](#8-calibration-loop)
9. [Composition with Other RFCs](#9-composition-with-other-rfcs)
10. [Schema Sketch (Illustrative)](#10-schema-sketch-illustrative)
11. [Backward Compatibility](#11-backward-compatibility)
12. [Alternatives Considered](#12-alternatives-considered)
13. [Implementation Plan](#13-implementation-plan)
14. [Open Questions](#14-open-questions)
15. [References](#15-references)

---

## 1. Summary

[RFC-0015 (Autonomous Pipeline Orchestrator)](RFC-0015-autonomous-pipeline-orchestrator.md) ships `cli-orchestrator tick` as a one-shot dispatch unit. In practice an operator manually invokes it every time work should move forward; nothing wakes the orchestrator on its own cadence. This RFC introduces a **deterministic preflight predicate** + a **`/loop`-driven heartbeat** that wakes the orchestrator on a fixed interval but dispatches expensive agent work only when there's actually something to do AND budget to do it with.

The architecture mirrors the deterministic-first ladder already used in [RFC-0011 §4.4 (DoR Gate)](RFC-0011-definition-of-ready-gate.md) and the [review-calibration system](../../docs/api-reference/review-calibration.md):

1. **Stage A (deterministic, ~5s)** — backlog frontier, PR frontier, cost rail, stale-task sweep, operator-fatigue gate
2. **Stage B (structural rubric, optional small-LLM, ~30s)** — only when Stage A leaves ambiguity
3. **Stage C (LLM, last resort, ~60s)** — only when A + B leave the mid-confidence band

~95% of ticks should resolve at Stage A as cheap status sweeps. The ~5% that escalate to actual dispatch are the only ones that burn subagent cost. The whole point of the predicate is that **a naïve heartbeat is the fastest known way to burn budget** — the operator captured exactly that failure mode on 2026-05-09 (`feedback_subagent_session_cost_cap`).

## 2. Motivation

### 2.1 Manual triggering is the current friction

Today an operator running the orchestrator types `cli-orchestrator tick` (or invokes the equivalent slash command) every time they want work to advance. They are the cadence. This works at small scale but conflicts with the Decision Engine premise in `VISION.md` §2-§3: the operator's time goes to the highest-leverage activity (decisions), not the lowest (typing `tick` over and over).

### 2.2 A naïve heartbeat is the fastest known way to burn budget

The operator-saved memory captures the failure mode: an 8+ hour subagent loop on Opus 4.7 burned through the weekly subscription window plus 98% of CA$280 monthly overage in 4 days. Any heartbeat design that fires `cli-orchestrator tick` on a schedule without a cost gate will reliably reproduce that incident. The predicate is therefore not optional polish — it's the load-bearing cost-protection mechanism.

### 2.3 The framework already has the building blocks

What's missing is composition, not new capability:

- **Backlog frontier**: `cli-deps frontier` (RFC-0014, shipped)
- **DoR-ready filter**: RFC-0011 dor-readiness, shipped
- **Dispatchability filter**: `dispatchable: false` frontmatter (AISDLC-243, shipped)
- **Cost ledger**: `orchestrator/src/cost-tracker.ts`, `state/schema.ts` `cost_ledger` table (RFC-0004 substrate, shipped)
- **CostPolicy + CostGovernancePlugin**: budget windows, soft/hard limits, circuit-breaker actions (RFC-0004, shipped)
- **events.jsonl writer**: RFC-0015 Phase 5, shipped
- **Operator fatigue signal**: declared explicitly (`feedback_decision_fatigue_signal` memory); RFC-0035 formalizes it

This RFC composes the above into a `should-tick` predicate and ships the cadence wrapper.

### 2.4 What's missing

- A single deterministic predicate that aggregates the existing signals into `{ shouldDispatch, reason, candidates }`
- A cadence mechanism (the `/loop` wrapper) that fires the predicate cheaply
- A `costPolicy.heartbeat` schema extension that caps dispatching ticks per-tick / daily / weekly
- A heartbeat-specific calibration corpus so we can replay decisions and tune thresholds

## 3. Goals and Non-Goals

### 3.1 Goals

- **G1.** `/loop`-driven heartbeat fires the orchestrator on a configurable cadence (default 20–30 min) without operator typing.
- **G2.** A `cli-orchestrator should-tick --json` deterministic predicate decides whether each tick dispatches or no-ops.
- **G3.** Cost-rail enforcement: per-tick, daily, and weekly ceilings short-circuit dispatch with explicit `defer` / `abort` / `alert` actions.
- **G4.** Operator-fatigue gate suppresses dispatch when explicitly declared (composes with [RFC-0035 §7](RFC-0035-decision-catalog-operator-routing.md)).
- **G5.** Calibration via `events.jsonl`: every should-tick decision + outcome is logged; a `cli-orchestrator-heartbeat-corpus aggregate` replays them.
- **G6.** Cheap status ticks dominate (~95%); dispatching ticks are the bounded exception (~5%).
- **G7.** Subscription-billing path remains the default (operator's Claude Code session); API-key path is the alternative for off-hours / unattended.

### 3.2 Non-Goals

- **N1.** Daemon mode (long-running blocking process). `/loop` is the v1 cadence vehicle. A future RFC can revisit if `/loop`'s "requires open Claude Code session" limit becomes binding.
- **N2.** Cross-operator coordination. Solved separately via the `IssueTracker` adapter framework ([RFC-0010 §13](RFC-0010-parallel-execution-worktree-pooling.md), [RFC-0003](RFC-0003-infrastructure-adapters.md)) when teams move off Backlog.md.
- **N3.** Remote/CCR execution. CCR sandboxes are read-only by design (operator policy in `CLAUDE.md`); heartbeat must run on the operator's machine.
- **N4.** Replacing `cli-orchestrator tick`. Tick remains the unit of work; this RFC adds the cadence layer around it.
- **N5.** Cross-loop arbitration (multiple `/loop` sessions on the same operator's machine). Single-session v1; multi-session lock is OQ-7.

## 4. The Deterministic Preflight Predicate

`cli-orchestrator should-tick --json` is the cheap predicate. Its output is the only signal the heartbeat consults before deciding whether to dispatch.

### 4.1 Three-stage evaluation (mirrors RFC-0011 §4.4)

#### Stage A — Deterministic (no LLM, ~5s)

| Check | Mechanism | Output |
|---|---|---|
| Backlog frontier | `cli-deps frontier --filter dor-ready,dispatchable,dep-ready --format json` (RFC-0014 substrate) | `candidates[]` |
| PR frontier | `gh pr list --author=@me --state=open --json mergeStateStatus,reviewDecision,headRefName` | `prsActionable[]` (CHANGES_REQUESTED, failing checks, needs-rebase) |
| Cost rail | Read `cost_ledger` + `CostPolicy.heartbeat`; compare burn vs ceilings | `costRail { burn, ceiling, headroom }` |
| Stale-task sweep | Tasks `In Progress` with no commit activity > stale-threshold | `staleTasks[]` |
| Operator-fatigue gate | Explicit operator signal (TUI command, memory key, or `.ai-sdlc/operator-state.yaml`) | `fatigueActive: bool` |

Stage A produces a clear verdict for ~95% of ticks:

- **shouldDispatch = false** when fatigue active OR cost rail at ≥ 90% AND no critical work
- **shouldDispatch = true** when backlog/PR frontier non-empty AND cost rail headroom OK
- **ambiguous** when signals conflict (e.g. critical task ready but cost rail tight) — escalate to Stage B

#### Stage B — Structural rubric (optional small-LLM, ~30s)

Only fires for the ambiguous band. Scores each candidate task on:

- **Priority** — PPA score (RFC-0008), deadline distance, blocking-others count
- **Cost-per-task projection** — historical mean from cost_ledger filtered by task tier
- **Dependency risk** — would dispatching this task unblock others?

Rubric is deterministic where possible; uses a Haiku-class LLM only for explicitly subjective sub-scores anchored to `decision-exemplars.yaml`-style calibration (same pattern as review-calibration meta-review).

#### Stage C — LLM as last resort (~60s)

Fires only when Stage A + B leave a confidence gap. Single-turn structured-output call with the question "given these signals, should we dispatch now or defer?" and the calibration files as anchors. Output: `{ shouldDispatch, confidence, rationale, alternatives }`.

### 4.2 Confidence thresholds (mirrors review-calibration)

| Composite confidence | Action |
|---|---|
| ≥ 0.8 dispatch | Proceed to `cli-orchestrator tick --candidates ...` |
| ≥ 0.8 defer | Log to events.jsonl with reason; no-op tick |
| 0.5 – 0.8 | Stage C runs; defer-by-default if still ambiguous |
| < 0.5 | Defer with `requires-operator-review` flag; surface to [RFC-0035 Decision Catalog](RFC-0035-decision-catalog-operator-routing.md) for human review |

### 4.3 Predicate output schema (illustrative)

```typescript
interface ShouldTickResult {
  shouldDispatch: boolean;
  confidence: number;            // 0..1
  reason: string;                // one-line operator-readable
  stage: 'A' | 'B' | 'C';        // which stage produced the verdict
  candidates: string[];          // task ids if shouldDispatch
  deferReason?: 'no-work' | 'cost-ceiling' | 'fatigue-gate' | 'ambiguous-requires-review';
  signals: {
    backlogReady: number;
    prsActionable: number;
    costRail: { burnUsd: number; ceilingUsd: number; headroomPct: number };
    fatigueActive: boolean;
    staleTasks: number;
  };
}
```

## 5. The `/loop` Heartbeat Mechanism

### 5.1 Operator UX

```bash
/loop 25m /ai-sdlc orchestrator-heartbeat
```

The existing `/loop` skill fires the slash command on the chosen interval. The Claude Code session must stay open; killing the session kills the heartbeat. This is intentional for v1 — `/loop` matches the operator's working hours and uses subscription billing.

### 5.2 `/ai-sdlc orchestrator-heartbeat` slash command body

```
1. Invoke `cli-orchestrator should-tick --json`
2. If shouldDispatch == false:
     - Append decision to .ai-sdlc/_heartbeat/events.jsonl
     - Print one-line summary (cheap tick, ~5s)
     - Exit
3. If shouldDispatch == true:
     - Invoke `cli-orchestrator tick --candidates <ids> --budget-cap $perTickCeiling`
     - Append decision + outcome to .ai-sdlc/_heartbeat/events.jsonl
     - Print summary including dispatched task ids + cost
4. If shouldDispatch == "requires-operator-review":
     - Surface to RFC-0035 Decision Catalog
     - No-op; let operator answer at next interaction
```

### 5.3 Interval semantics

- **Default**: 25 min (OQ-1 to confirm)
- **Min**: 5 min (prevent cost-rail thrash)
- **Max**: 60 min (slower cadence loses work-freshness)
- **Backoff on dispatch failure**: 2× current interval, max 60 min; resets to default on next success

### 5.4 Cheap-tick guarantee

The Stage A predicate MUST complete in < 10s wall-clock on a healthy network. Operators rely on cheap ticks being invisible; a tick that takes 30s starts feeling like a foreground process.

## 6. Cost-Rail Integration

Extends [RFC-0004 (Cost Governance)](RFC-0004-cost-governance-and-attribution.md) with a `heartbeat` section in `CostPolicy`.

### 6.1 `CostPolicy.heartbeat` schema (illustrative)

```yaml
costPolicy:
  heartbeat:
    perTickCeilingUsd: 5.00       # max spend in one dispatching tick
    dailyCeilingUsd: 50.00        # max heartbeat-driven spend per 24h
    weeklyCeilingUsd: 200.00      # max per 7d
    headroomThresholdPct: 10      # if remaining headroom < 10%, defer unless critical
    onCeilingHit: defer           # defer | abort | alert
    criticalBypass:
      deadlineWithinHours: 24
      blockingOthersMin: 5
```

### 6.2 Rail enforcement at each stage

- **Stage A** reads `cost_ledger` for current burn vs ceilings; flags `costRail.headroomPct < threshold` as a defer signal
- **Pre-dispatch** (between Stage A success and actual `tick` invocation) re-checks the rail one more time using `cli-orchestrator status --cost` — protects against rapid concurrent ticks
- **Post-dispatch** logs actual cost to `cost_ledger` with `source: heartbeat` for replay attribution

### 6.3 Critical-task bypass

Some tasks shouldn't wait for budget headroom — e.g. a fix blocking 5 other tasks, or a deadline today. `criticalBypass` lets those tasks dispatch even when the rail is tight, with explicit logging for operator review at the next interaction.

## 7. Operator-Fatigue Gate

Same primitive as [RFC-0035 §7](RFC-0035-decision-catalog-operator-routing.md). The heartbeat respects:

- **Explicit signal**: operator command (`ai-sdlc operator-state fatigue --on` or TUI button) sets `fatigueActive: true` in `.ai-sdlc/operator-state.yaml`. Stage A reads this.
- **Inferred signal (opt-in)**: override-rate or rapid-defer patterns. Off by default; RFC-0035 owns the calibration of inferred fatigue.

When fatigue is active, heartbeat **defers all dispatching ticks** until the operator clears the signal. Cheap ticks still run (predicate, status logging) so the corpus stays warm.

### 7.1 What heartbeat MUST NOT do under fatigue

- Dispatch developer subagents
- Open new PRs
- Spawn reviewer subagents

The heartbeat MAY still:
- Sweep stale tasks and flag them for operator review
- Update `events.jsonl`
- Refresh cached status signals

## 8. Calibration Loop

### 8.1 Per-tick events

Each heartbeat decision appends a record to `.ai-sdlc/_heartbeat/events.jsonl`:

```jsonl
{"ts":"2026-05-13T18:00:00Z","decision":"dispatch","stage":"A","reason":"3 backlog ready, cost rail 25%","candidates":["AISDLC-269","AISDLC-270"],"signals":{...},"outcome":"dispatched","cost":2.40,"durationMs":4321}
{"ts":"2026-05-13T18:25:00Z","decision":"defer","stage":"A","reason":"no DoR-ready backlog, no actionable PRs","outcome":"skipped","cost":0.00,"durationMs":3120}
```

### 8.2 Corpus aggregator

`cli-orchestrator-heartbeat-corpus aggregate` (mirrors RFC-0015 Phase 5 `cli-orchestrator-corpus`) replays events to compute:

- **Dispatch precision**: % of dispatches that produced merged work within 7d
- **False-negative rate**: tasks deferred that subsequently shipped without heartbeat help (operator manually ran tick)
- **Cost-per-dispatched-task**: avg burn per heartbeat-driven dispatch
- **Stage A/B/C activation balance**: ideal is ~85/12/3
- **Defer-reason distribution**: which reason dominates (no-work / cost / fatigue / ambiguous)

### 8.3 Threshold tuning

Operator periodically reviews the corpus + adjusts `CostPolicy.heartbeat` ceilings, `stale-threshold`, and (eventually) the Stage B rubric weights. Same hybrid-promotion runbook pattern as RFC-0014 / RFC-0015.

## 9. Composition with Other RFCs

| RFC | Role | This RFC's relationship |
|---|---|---|
| [RFC-0004](RFC-0004-cost-governance-and-attribution.md) Cost Governance | CostPolicy + cost_ledger substrate | This RFC extends `CostPolicy.heartbeat` schema; reads `cost_ledger` |
| [RFC-0011](RFC-0011-definition-of-ready-gate.md) DoR Gate | Deterministic-first ladder model | Reused for Stage A → B → C predicate evaluation |
| [RFC-0014](RFC-0014-dependency-graph-composition.md) Dep Graph | `cli-deps frontier` | Stage A backlog-frontier input |
| [RFC-0015](RFC-0015-autonomous-pipeline-orchestrator.md) Autonomous Orchestrator | `cli-orchestrator tick` + `events.jsonl` | This RFC adds the cadence layer; tick stays unchanged; events.jsonl gains `source: heartbeat` records |
| [RFC-0023](RFC-0023-operator-tui-pipeline-monitoring.md) Operator TUI | Heartbeat status pane | `should-tick` result surfaces in TUI; deferred ticks visible |
| [RFC-0024](RFC-0024-emergent-issue-capture-and-triage.md) Emergent capture | Stale-task sweep emits captures | When heartbeat finds an `In Progress` task with no activity, capture goes to RFC-0024 corpus |
| [RFC-0025](RFC-0025-framework-quality-monitoring.md) Framework quality | Failed dispatches feed quality monitoring | Heartbeat-dispatched failures classified per RFC-0025 §5 |
| [RFC-0035](RFC-0035-decision-catalog-operator-routing.md) Decision Catalog | `requires-operator-review` deferrals | Ambiguous heartbeat decisions route to operator's decision queue; fatigue gate reused |

## 10. Schema Sketch (Illustrative)

> **Note:** Illustrative for the Draft. Normative JSON Schema lands at Ready-for-Review.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: HeartbeatConfig
metadata:
  name: dogfood
spec:
  intervalMinutes: 25
  costPolicy:
    heartbeat:
      perTickCeilingUsd: 5.00
      dailyCeilingUsd: 50.00
      weeklyCeilingUsd: 200.00
      headroomThresholdPct: 10
      onCeilingHit: defer
      criticalBypass:
        deadlineWithinHours: 24
        blockingOthersMin: 5
  predicate:
    staleThresholdHours: 6
    stageBEnabled: true
    stageCEnabled: false   # opt-in; cost-sensitive
    stageCBudgetUsd: 0.10  # per Stage C call
  fatigueGate:
    respectExplicit: true
    inferFromOverrideRate: false   # opt-in (RFC-0035 calibration)
```

## 11. Backward Compatibility

- Net-new behavior behind feature flag `AI_SDLC_HEARTBEAT=experimental`. When unset, `cli-orchestrator tick` continues as a manual one-shot — unchanged.
- `CostPolicy.heartbeat` is an optional schema extension. Existing CostPolicy resources without it default to a conservative ceiling derived from the existing `costBudget` and a heartbeat-disabled state.
- `events.jsonl` gains a new event shape (`source: heartbeat`); existing event-replay tooling treats unknown sources as informational (already the contract in RFC-0015).
- `/ai-sdlc orchestrator-heartbeat` is a new slash command; existing commands unchanged.

## 12. Alternatives Considered

### 12.1 Alternative A — GitHub Actions cron as primary

Schedule a workflow to run `cli-orchestrator tick` every 20 min via `schedule: cron`. Rejected as v1 primary because:

- CCR / remote sandboxes are read-only by design (operator policy in `CLAUDE.md`); they can't sign attestations or push from CI without significant new infra
- API-key billing path is more expensive than subscription per the dogfood cost model
- Operator visibility into heartbeat state is worse (no inline TUI status)

Cron remains a future option for off-hours coverage, layered on top of `/loop` not replacing it.

### 12.2 Alternative B — Local daemon (`cli-orchestrator daemon`)

Long-running blocking process on operator boxes (launchd / systemd). Rejected for v1 because:

- `/loop` reuses existing Claude Code session infrastructure; no new daemon supervision needed
- Daemon mode adds operator-side install friction
- Cost model is similar (subscription) but harder to observe

If `/loop`'s "requires session open" turns out to be binding, a future RFC can carve out daemon mode without re-litigating the predicate or cost-rail design.

### 12.3 Alternative C — Event-driven only (push trigger, PR close, etc.)

Fire the orchestrator reactively from GitHub events (push, PR merge, issue label). Rejected because:

- Misses periodic sweeps (stale tasks, DoR re-checks, cost-rail rollovers)
- Burst-prone — a single PR merge can trigger a cascade of dispatches
- Doesn't address the "manual triggering" problem when no events fire (weekends, holidays)

Event triggers may compose with the heartbeat later as an *additional* signal (skip the next scheduled tick if an event-driven tick just ran), but not as the only mechanism.

### 12.4 Alternative D — Naïve heartbeat (no predicate)

`/loop 25m cli-orchestrator tick --force`. Rejected because:

- Per the operator-saved cost-cap memory, this is the exact failure mode that burned weekly + monthly budget in 4 days
- No backoff under fatigue
- No cost-rail enforcement

The predicate is therefore not optional — it's the load-bearing cost-protection mechanism.

## 13. Implementation Plan

Phased rollout behind `AI_SDLC_HEARTBEAT=experimental` (mirrors RFC-0014 / RFC-0015 promotion convention):

- [ ] **Phase 1.** `cli-orchestrator should-tick --json` Stage A only (deterministic): backlog + PR frontier + stale-task sweep
- [ ] **Phase 2.** `/ai-sdlc orchestrator-heartbeat` slash command wraps should-tick + tick; basic events.jsonl writer
- [ ] **Phase 3.** Cost-rail integration: `CostPolicy.heartbeat` schema extension + Stage A cost check
- [ ] **Phase 4.** Operator-fatigue gate: explicit signal honored; composes with RFC-0035 if it's shipped, otherwise standalone
- [ ] **Phase 5.** Stage B rubric (structural scoring with optional Haiku-class LLM)
- [ ] **Phase 6.** Stage C LLM as last resort (single-turn structured output)
- [ ] **Phase 7.** `cli-orchestrator-heartbeat-corpus aggregate` calibration replay
- [ ] **Phase 8.** Critical-task bypass for deadline / blocking-others overrides
- [ ] **Phase 9.** TUI surface (RFC-0023 integration) — heartbeat status pane
- [ ] **Phase 10.** Hybrid promotion runbook (`docs/operations/heartbeat-promotion.md`) — operators flip default-on once corpus shows ≥ 90% dispatch precision + cost rail effective

## 14. Open Questions

1. **Default interval** — 20, 25, or 30 minutes? Memory note recommends "every 20-30 min" but doesn't pick. Calibrate via corpus once Phase 7 ships.
2. **Should-tick result caching** — does a Stage A result stay valid for N minutes to avoid re-hitting `gh pr list` on rapid consecutive ticks? Or always-fresh?
3. **PR frontier scope** — only `@me` PRs, or all open PRs in the dogfood repo? Multi-operator scenarios where multiple operators run heartbeats simultaneously need defined ownership.
4. **Cost rail granularity** — per-tick ceiling alone, daily alone, or layered? Likely all three (current §6.1 sketch), but cost of enforcement at each layer is unclear.
5. **Stale-task threshold** — 6h, 12h, 24h? Probably configurable per `HeartbeatConfig`; default needs a number.
6. **Failure-replay semantics** — if a heartbeat-dispatched tick fails (verification, push race, etc.), when's the soonest retry? Backoff curve TBD.
7. **Cross-loop coordination** — if an operator has multiple `/loop` sessions running heartbeat simultaneously (e.g. one per repo), which wins? File-based lock? Per-repo isolation?
8. **Heartbeat vs operator-foreground priority** — if operator starts manual `cli-orchestrator tick` mid-heartbeat-interval, should the next heartbeat back off? Lock semantics during operator interactive sessions?
9. **Stage A signal weight** — currently treats backlog + PR + cost as separate gates with explicit defer rules. Could be a weighted composite score instead. Composite is more flexible; explicit gates are more debuggable. Pick one for v1.
10. **Calibration corpus retention** — append-only forever? Rolling window? Same question RFC-0005 OQ-5 carries; could be solved jointly.
11. **Inferred-fatigue threshold** — RFC-0035 OQ-8 owns this. Heartbeat consumes the signal; doesn't define it.
12. **GitHub Actions cron complement** — should there be an explicit off-hours cron tick that runs at lower frequency (every 4h) with stricter cost rail, layered on top of `/loop` for active hours? Or is that scope creep until `/loop`'s daytime use proves out?

## 15. References

- [`VISION.md`](../../VISION.md) §2 (cost-asymmetry) and §3 (operator-as-decision-steward, not as cadence-typer)
- [RFC-0004 Cost Governance](RFC-0004-cost-governance-and-attribution.md) — CostPolicy substrate
- [RFC-0011 Definition-of-Ready Gate](RFC-0011-definition-of-ready-gate.md) §4.4 — Deterministic-first evaluation order pattern
- [RFC-0014 Dependency Graph Composition](RFC-0014-dependency-graph-composition.md) — `cli-deps frontier` substrate
- [RFC-0015 Autonomous Pipeline Orchestrator](RFC-0015-autonomous-pipeline-orchestrator.md) — `cli-orchestrator tick` + `events.jsonl` substrate
- [RFC-0023 Operator TUI](RFC-0023-operator-tui-pipeline-monitoring.md) — Surface for heartbeat status
- [RFC-0024 Emergent Issue Capture](RFC-0024-emergent-issue-capture-and-triage.md) — Stale-task sweep emits captures here
- [RFC-0025 Framework Quality Monitoring](RFC-0025-framework-quality-monitoring.md) — Failed heartbeat dispatches classified here
- [RFC-0035 Decision Catalog](RFC-0035-decision-catalog-operator-routing.md) — Ambiguous heartbeat decisions route here; fatigue gate primitive shared
- [`docs/api-reference/review-calibration.md`](../../docs/api-reference/review-calibration.md) — Deterministic preprocessing → confidence-tiered → meta-review pattern this RFC mirrors
- Memories: `feedback_subagent_session_cost_cap`, `feedback_autonomous_orchestration_pattern`, `feedback_decision_fatigue_signal`
