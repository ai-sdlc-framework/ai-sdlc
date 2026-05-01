---
id: RFC-0014
title: Dependency Graph Composition for Pipeline Decisions
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-01
updated: 2026-05-01
targetSpecVersion: v1alpha1
requiresDocs: []
---

# RFC-0014: Dependency Graph Composition for Pipeline Decisions

**Status:** Draft (initial seed; structure may shift)
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-05-01
**Updated:** 2026-05-01
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io (pending)
- [ ] Product owner — Alex (pending)
- [ ] Operator owner — dominique@reliablegenius.io (pending)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-05-01 | dominique | Initial draft. Foundation tooling lives in AISDLC-117 (`cli-deps`); this RFC scopes the composition layer (PPA + DoR + critical-path + cross-RFC). |

---

## 1. Summary

The `dependencies:` frontmatter field on every backlog task encodes a directed acyclic graph of work order. AISDLC-117 ships a foundation `cli-deps` CLI that materializes this graph for dispatch frontier queries. This RFC scopes the **composition layer** — how the graph integrates with the existing PPA (priority), DoR (admission), and observability surfaces to produce smarter pipeline decisions than either subsystem makes in isolation.

Three composition points:

1. **PPA × Graph** → depth-aware priority. A high-PPA task whose blocker is a low-PPA task should auto-bump the blocker's score so the critical path moves first.
2. **DoR × Graph** → blast-radius surfacing. When an issue lands in `Needs Clarification`, the DoR comment should tell the author "this gates N downstream tasks" so the urgency is legible.
3. **Graph × Observability** → critical-path digest. Slack/dashboard surfaces the next 3-5 critical-path items so operators don't waste cycles on graph leaves while a 12-task chain stalls.

Plus one cross-cutting capability: **cross-RFC dependency tracking** so the RFC index reflects which RFCs gate which.

## 2. Motivation

### 2.1 The cost of NOT composing

The morning of 2026-05-01 surfaced four real costs of dispatching without graph awareness:

- **Duplicate dispatch** (AISDLC-104): a parallel session merged the task hours earlier; the foundation `cli-deps` (AISDLC-117) catches this. PPA composition adds: it would have ranked the duplicate as zero-impact (no downstream unblocked) and skipped automatically.
- **Manual chain tracing**: 100.4 needs 100.3; 100.8 needs 100.7+100.4; the RFC-0011 phase chain is 9 tasks deep. Without composition, the operator (or Claude) reads task descriptions to figure out what to dispatch next. The frontier query alone helps; depth-aware priority makes it obvious which leaf-of-deep-chain to start FIRST.
- **DoR surprise blast radius**: a `Needs Clarification` verdict on a foundation issue stalls 12 downstream tasks. Without composition, the author sees "this is unclear" but doesn't know "your delay costs N tasks." The DoR feedback flywheel can't calibrate against blast-radius signal it doesn't capture.
- **No critical-path visibility**: when planning the morning, no surface said "this 5-task chain blocks 12 downstream items, prioritize the head."

### 2.2 Why these compose

PPA scores priority. DoR scores actionability. The dependency graph scores **causal reach** (how much else does this unlock?). All three are orthogonal axes — composing them via a multiplicative weighting produces decisions that no single axis can produce.

Concretely:

- A high-PPA, DoR-ready, leaf-of-deep-chain task is **the** task to dispatch next.
- A low-PPA, DoR-ready, leaf-of-shallow-chain task can wait.
- A medium-PPA, DoR-failed, root-of-deep-chain task is the **highest-leverage clarification ask** — fixing it unblocks the most.

None of these decisions can be made by PPA, DoR, or the graph in isolation. Composition is what turns them from independent gates into a strategic dispatcher.

## 3. Goals and Non-Goals

### Goals

- Compose the dependency graph (AISDLC-117) with PPA priority scoring (RFC-0008).
- Compose the dependency graph with DoR admission verdicts (RFC-0011).
- Surface critical-path information in Slack digest + operator dashboard.
- Track dependencies between RFCs (not just between tasks) so the RFC index reflects strategic ordering.

### Non-Goals

- Replace PPA or DoR. This RFC composes them; it does not change their scoring/admission semantics.
- Implement the foundation graph CLI itself. That's AISDLC-117. This RFC depends on 117 shipping first.
- Cross-repo dependency tracking. Cross-RFC stays within `spec/rfcs/`; cross-repo (e.g., this project depends on `ai-sdlc-io`) is a future concern.

## 4. The Graph as a First-Class Object

AISDLC-117 ships `cli-deps frontier|blockers|impact|validate|graph` as a CLI surface over the in-memory graph computed from `backlog/tasks/*.md` + `backlog/completed/*.md` frontmatter. This RFC promotes that graph from a CLI artifact to a **first-class pipeline object** consumable by:

- The PPA scorer (Section 5)
- The DoR comment generator (Section 6)
- The Slack/dashboard digest (Section 7)
- The RFC index renderer (Section 8)

### 4.1 Graph snapshot artifact

Each pipeline tick MAY emit a snapshot at `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` containing:

```jsonl
{"id":"AISDLC-115.1","status":"To Do","dependsOn":[],"unblocks":["AISDLC-115.2"],"depth":0,"reach":9}
{"id":"AISDLC-115.2","status":"To Do","dependsOn":["AISDLC-115.1"],"unblocks":["AISDLC-115.3"],"depth":1,"reach":8}
```

`depth` = longest chain from a graph root. `reach` = transitive closure of `unblocks`. Both are computable in O(V + E) per snapshot.

This artifact becomes the input for the composition layers below.

## 5. PPA × Graph: Depth-Aware Priority

### 5.1 The problem

PPA scores each task on 7 dimensions (RFC-0005) producing a composite priority. But PPA is local — it scores task X on its own merits without considering what X unblocks. A high-PPA task whose blocker is a low-PPA task today gets stuck behind the blocker because PPA can't see the chain.

### 5.2 The composition

Define `effectivePriority(task) = priority(task) + maxDownstreamPriority(task)` where `maxDownstreamPriority` = the highest PPA priority of any task in `task.unblocks` transitive closure.

Effect: a low-PPA task that unblocks a high-PPA task inherits the high-PPA's urgency. Critical-path leaves bubble to the top of the dispatch queue automatically.

### 5.3 Boundaries

- The composition is **read-only** for PPA. PPA's per-task score is unchanged in the calibration log; only the dispatcher's priority sort is affected.
- The composition is bounded by the graph depth. A 20-task chain doesn't get 20× boost — `maxDownstreamPriority` is a max, not a sum.
- The composition is monotonic. Adding a new dependency edge can only INCREASE effective priority of upstream tasks, never decrease.

## 6. DoR × Graph: Blast-Radius Surfacing

### 6.1 The problem

When DoR (RFC-0011) returns an issue to `Needs Clarification`, the author sees the per-gate clarification questions. They don't see how much downstream work their delay blocks.

### 6.2 The composition

Extend the DoR clarification comment template to include:

> ⚠ **This issue currently gates N downstream tasks** (AISDLC-X, AISDLC-Y, ...). Resolving the questions above unblocks the entire chain.

Where N = `task.reach` from the graph snapshot.

For very large N (>5), the comment lists the top 3 highest-PPA downstream items by name + a "see N total" link to the graph view.

### 6.3 Effect on the calibration loop

DoR's calibration log (RFC-0011 §5.5) gains a new field per verdict:

```jsonl
{"task":"AISDLC-N","verdict":"needs-clarification","gates":[1,4],"blastRadius":12,"highestDownstreamPriority":85}
```

This lets RFC-0011's Phase 7 soak distinguish "false positive on a leaf" (low cost) from "false positive on a chain root" (high cost). The flywheel learns which gates produce high-cost false positives and tunes them more aggressively.

## 7. Graph × Observability: Critical-Path Digest

### 7.1 Slack weekly digest

The existing weekly digest (RFC-0011 §8 + RFC-0010 cli-status) gains a section:

```
🛤️ Critical Path This Week
1. AISDLC-115.2 (Phase 2a Stage A) — blocks 7 downstream
2. AISDLC-117 (cli-deps foundation) — blocks 4 downstream
3. AISDLC-118 (RFC lifecycle) — blocks 2 downstream
```

Sorted by `effectivePriority` (Section 5).

### 7.2 Dashboard rendering

The operator dashboard (referenced in RFC-0010 cli-status) renders the graph as an interactive view: click a task → see its blockers + downstream + PPA score + DoR verdict. Mermaid-style rendering with color-coding by status (To Do = blue, In Progress = yellow, Needs Clarification = red, Done = green).

## 8. Cross-RFC Dependency Tracking

### 8.1 The problem

RFC-0011 Phase 4 depends on RFC-0008 (PPA composition). RFC-0014 (this RFC) depends on AISDLC-117 (cli-deps foundation). Today these dependencies are buried in prose; the RFC index doesn't surface them.

### 8.2 The composition

RFC frontmatter gains a `Depends-On:` field listing other RFCs:

```yaml
---
id: RFC-0014
title: Dependency Graph Composition for Pipeline Decisions
Depends-On: [RFC-0005, RFC-0008, RFC-0010, RFC-0011]
...
---
```

The `spec/rfcs/README.md` index renders these as a separate dependency table:

| RFC | Depends On | Required By |
|---|---|---|
| RFC-0014 | RFC-0005, RFC-0008, RFC-0010, RFC-0011 | (none yet) |
| RFC-0011 | (none) | RFC-0014 |

This makes RFC implementation order legible at a glance.

## 9. Schema Changes

- New `Depends-On:` array field in RFC frontmatter (Section 8.2).
- New `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` artifact (Section 4.1).
- New `blastRadius` + `highestDownstreamPriority` fields in DoR calibration log (Section 6.3).
- Extension to PPA dispatcher's priority comparator (Section 5.2) — internal API change, no schema change.

## 10. Backward Compatibility

- All composition layers are **opt-in** behind feature flag `AI_SDLC_DEPS_COMPOSITION`. Default `off` until shipped + soaked.
- AISDLC-117 ships first as the foundation; this RFC's compositions land incrementally on top.
- Existing PPA scoring + DoR verdicts unchanged when the flag is off.

## 11. Alternatives Considered

### 11.1 Bake graph awareness into PPA itself

Could have made PPA's scoring algorithm directly graph-aware (e.g., "include downstream reach as an 8th dimension"). Rejected because:

- PPA's 7 dimensions are stable + signed-off (RFC-0005, RFC-0008). Adding an 8th would re-litigate calibration.
- The graph-awareness is a **dispatch concern**, not a scoring concern. Keeping them separate respects the RFC-0005 architecture.

### 11.2 Skip the DoR composition

DoR is fresh (RFC-0011 just signed off May 1). Could ship the PPA + observability compositions first and add DoR later. Considered; rejected because the DoR/graph composition produces immediate value (blast radius is high-signal for authors) and the cost is small.

### 11.3 Compute graph in PPA scorer instead of as a CLI

Could have made the dependency graph a private internal of the PPA scorer rather than a first-class CLI. Rejected because the CLI is also useful for sprint planning, RFC index rendering, and ad-hoc operator queries — none of which should require running the PPA scorer.

## 12. Implementation Plan

Sequential phases, each behind feature flag `AI_SDLC_DEPS_COMPOSITION`.

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 1: Snapshot artifact** | 0.5 wk | Emit `$ARTIFACTS_DIR/_deps/snapshot.*.jsonl` per pipeline tick using AISDLC-117's graph computer | Snapshot validates against schema; readable by downstream consumers |
| **Phase 2: PPA composition** | 1 wk | Extend dispatcher's priority comparator to use `effectivePriority`; integration test with chain fixtures | Critical-path leaves bubble to top; PPA per-task scores unchanged |
| **Phase 3: DoR composition** | 0.5 wk | Extend DoR comment template + calibration log with blast-radius fields | Vague root-of-chain issue gets blast-radius callout in DoR comment |
| **Phase 4: Slack + dashboard digest** | 1 wk | Critical-path section in weekly digest; dashboard graph view | Digest renders top 3-5; dashboard interactive |
| **Phase 5: Cross-RFC tracking** | 0.5 wk | `Depends-On:` frontmatter + index table renderer; `pnpm rfc:check` validates references resolve | RFC index shows dependency graph; CI catches dangling refs |
| **Phase 6: Soak + flag promotion** | corpus-driven, NOT calendar-gated | Run with flag off → operators opt in → measure dispatch quality vs PPA-only baseline | Promotion when dispatch correctness > 95% AND no operator override-rate spike |

Total wall-clock: ~3-4 weeks (Phase 6 is corpus-driven per maintainer directive 2026-05-01).

Critical path: Phase 1 → Phase 2 → Phases 3/4/5 (parallelizable) → Phase 6.

## 13. Open Questions

1. **Q1: How does the depth-aware priority interact with PPA's existing tie-breaking rules?** PPA uses recency as a tie-breaker after composite score. When two tasks have equal effective priority, should depth-aware priority override the recency tiebreaker, or compose with it? Lean: compose. Decide before Phase 2 ships.

2. **Q2: What's the right graph artifact retention policy?** Snapshots accumulate in `$ARTIFACTS_DIR/_deps/`. Without retention, this grows unbounded. Lean: keep last 30 days + the snapshot at any RFC-significant event (major dispatch decision, calibration revision). Decide before Phase 1 ships.

3. **Q3: Should Cross-RFC dependencies be enforced or advisory?** If RFC-A `Depends-On: [RFC-B]` and RFC-B is `Lifecycle: Draft`, can RFC-A reach `Lifecycle: Signed Off`? Lean: advisory in v1 (just surface in index); enforced in a future version. Decide before Phase 5 ships.

4. **Q4: How does the composition handle external dependencies?** A task may depend on something OUTSIDE the backlog system (e.g., "wait for npm version X to publish"). Lean: out of scope for v1; document the limitation. The graph models internal task dependencies only. Decide before Phase 1 ships.

5. **Q5: What's the cost of recomputing the graph per dispatch?** AISDLC-117 ships an in-memory graph; recompute cost is O(V+E) which is trivial for our task counts. But if the dispatcher recomputes per dispatch decision (vs caching), per-decision overhead matters at scale. Lean: cache with a 30s TTL. Decide before Phase 2 ships.

6. **Q6: How does DoR blast-radius interact with the auto-pass rules?** Alex's signal-pipeline auto-pass (RFC-0011 Addition 1) skips gates 1, 4, 5, 6. If a signal-pipeline-generated task has high blast radius, should the DoR comment STILL surface it even though most gates were skipped? Lean: yes, surface always — blast radius is independent of gate evaluation. Decide before Phase 3 ships.

7. **Q7: Does the graph snapshot need a write barrier with the Backlog.md adapter?** If the operator edits a task's `dependencies:` field while the dispatcher is reading the snapshot, what's the consistency model? Lean: snapshots are point-in-time; concurrent edits become visible at the next snapshot. No write barrier needed. Decide before Phase 1 ships.

## 14. References

- RFC-0005 — Product Priority Algorithm (PPA scoring foundation)
- RFC-0008 — PPA Triad Integration
- RFC-0010 — Parallel Execution and Worktree Pooling (cli-status digest pattern)
- RFC-0011 — Definition-of-Ready Gate (DoR comment template + calibration log)
- AISDLC-117 — Compute backlog task dependency graph (`cli-deps` foundation)
- AISDLC-118 — RFC lifecycle convention (provides `Lifecycle:` field this RFC composes with)
- Original conversation with @dominique establishing the need (2026-05-01): "we have a dependency graph of the order the issues should be developed in. yet we aren't computing this dependency graph"
