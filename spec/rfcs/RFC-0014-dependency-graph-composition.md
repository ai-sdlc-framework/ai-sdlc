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
| v2 | 2026-05-01 | dominique | Removed §8 (Cross-RFC dependency tracking) — scope creep. The pipeline dispatches tasks, not RFCs, so RFC-to-RFC dependencies don't drive any pipeline decision; that's a separate index-rendering concern that doesn't need RFC ceremony. Dropped §3 goal, §1 reference, Phase 5 from the implementation plan, the schema-change line, and Q3 from open questions. Renumbered §9-§14 → §8-§13 and Q4-Q7 → Q3-Q6 accordingly. |
| v3 | 2026-05-01 | dominique | All 6 open questions resolved (§12). Q1: depth as primary tiebreak, recency tertiary (B). Q2: 30d rolling + event-tagged permanent (C). Q3: `externalDependencies:` frontmatter, surfaced not blocking (B); §8 schema-changes updated. Q4: no cache, recompute every dispatch (A). Q5: reframed (original wording referenced a non-existent "signal-pipeline auto-pass" mechanism in RFC-0011) — `dor-bypass` × blast-radius gets a different FYI-shaped comment on bypass-admitted high-radius tasks (C). Q6: per-task atomic read with "best-effort consistency, validated by consumer" contract (C). Phase 3 needs to define both DoR comment templates (standard + bypass-FYI); Phase 1 needs `cli-deps gc` + `cli-deps inspect --tag <name>` per Q2. RFC ready for owner sign-off. |

---

## 1. Summary

The `dependencies:` frontmatter field on every backlog task encodes a directed acyclic graph of work order. AISDLC-117 ships a foundation `cli-deps` CLI that materializes this graph for dispatch frontier queries. This RFC scopes the **composition layer** — how the graph integrates with the existing PPA (priority), DoR (admission), and observability surfaces to produce smarter pipeline decisions than either subsystem makes in isolation.

Three composition points:

1. **PPA × Graph** → depth-aware priority. A high-PPA task whose blocker is a low-PPA task should auto-bump the blocker's score so the critical path moves first.
2. **DoR × Graph** → blast-radius surfacing. When an issue lands in `Needs Clarification`, the DoR comment should tell the author "this gates N downstream tasks" so the urgency is legible.
3. **Graph × Observability** → critical-path digest. Slack/dashboard surfaces the next 3-5 critical-path items so operators don't waste cycles on graph leaves while a 12-task chain stalls.

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

### Non-Goals

- Replace PPA or DoR. This RFC composes them; it does not change their scoring/admission semantics.
- Implement the foundation graph CLI itself. That's AISDLC-117. This RFC depends on 117 shipping first.
- Cross-repo dependency tracking. Cross-RFC stays within `spec/rfcs/`; cross-repo (e.g., this project depends on `ai-sdlc-io`) is a future concern.

## 4. The Graph as a First-Class Object

AISDLC-117 ships `cli-deps frontier|blockers|impact|validate|graph` as a CLI surface over the in-memory graph computed from `backlog/tasks/*.md` + `backlog/completed/*.md` frontmatter. This RFC promotes that graph from a CLI artifact to a **first-class pipeline object** consumable by:

- The PPA scorer (Section 5)
- The DoR comment generator (Section 6)
- The Slack/dashboard digest (Section 7)

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

## 8. Schema Changes

- New `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` artifact (Section 4.1).
- New `blastRadius` + `highestDownstreamPriority` fields in DoR calibration log (Section 6.3).
- Extension to PPA dispatcher's priority comparator (Section 5.2) — internal API change, no schema change.
- New `externalDependencies:` array field in backlog task frontmatter (Q3 resolution). Each entry: `{ id: string, description: string, kind: 'npm-version' | 'github-pr' | 'url-head' | 'manual' | 'other', resolverHint?: string }`. Surfaced in snapshot, DoR comment, and `cli-deps blockers`; not a dispatch gate in v1.

## 9. Backward Compatibility

- All composition layers are **opt-in** behind feature flag `AI_SDLC_DEPS_COMPOSITION`. Default `off` until shipped + soaked.
- AISDLC-117 ships first as the foundation; this RFC's compositions land incrementally on top.
- Existing PPA scoring + DoR verdicts unchanged when the flag is off.

## 10. Alternatives Considered

### 10.1 Bake graph awareness into PPA itself

Could have made PPA's scoring algorithm directly graph-aware (e.g., "include downstream reach as an 8th dimension"). Rejected because:

- PPA's 7 dimensions are stable + signed-off (RFC-0005, RFC-0008). Adding an 8th would re-litigate calibration.
- The graph-awareness is a **dispatch concern**, not a scoring concern. Keeping them separate respects the RFC-0005 architecture.

### 10.2 Skip the DoR composition

DoR is fresh (RFC-0011 just signed off May 1). Could ship the PPA + observability compositions first and add DoR later. Considered; rejected because the DoR/graph composition produces immediate value (blast radius is high-signal for authors) and the cost is small.

### 10.3 Compute graph in PPA scorer instead of as a CLI

Could have made the dependency graph a private internal of the PPA scorer rather than a first-class CLI. Rejected because the CLI is also useful for sprint planning, RFC index rendering, and ad-hoc operator queries — none of which should require running the PPA scorer.

## 11. Implementation Plan

Sequential phases, each behind feature flag `AI_SDLC_DEPS_COMPOSITION`.

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 1: Snapshot artifact** | 0.5 wk | Emit `$ARTIFACTS_DIR/_deps/snapshot.*.jsonl` per pipeline tick using AISDLC-117's graph computer | Snapshot validates against schema; readable by downstream consumers |
| **Phase 2: PPA composition** | 1 wk | Extend dispatcher's priority comparator to use `effectivePriority`; integration test with chain fixtures | Critical-path leaves bubble to top; PPA per-task scores unchanged |
| **Phase 3: DoR composition** | 0.5 wk | Extend DoR comment template + calibration log with blast-radius fields | Vague root-of-chain issue gets blast-radius callout in DoR comment |
| **Phase 4: Slack + dashboard digest** | 1 wk | Critical-path section in weekly digest; dashboard graph view | Digest renders top 3-5; dashboard interactive |
| **Phase 5: Soak + flag promotion** (AISDLC-167.5) | corpus-driven, NOT calendar-gated | Snapshot corpus aggregator (`cli-deps-corpus aggregate`) + operator override capture (`cli-deps log-override`) + hybrid promotion runbook ([`docs/operations/deps-composition-promotion.md`](../../docs/operations/deps-composition-promotion.md)) — corpus path or operator-override spot-check, both produce the same default-on end-state | Promotion when dispatch correctness > 95% AND no operator override-rate spike |

Total wall-clock: ~3 weeks (Phase 5 is corpus-driven per maintainer directive 2026-05-01).

Critical path: Phase 1 → Phase 2 → Phases 3/4 (parallelizable) → Phase 5.

## 12. Open Questions

1. **Q1: How does the depth-aware priority interact with PPA's existing tie-breaking rules?** PPA uses recency as a tie-breaker after composite score. When two tasks have equal effective priority, should depth-aware priority override the recency tiebreaker, or compose with it? Lean: compose. Decide before Phase 2 ships. **Resolution (2026-05-01):** Option B — depth as primary tiebreak, recency tertiary. Dispatcher sort order is `effectivePriority DESC` → `criticalPathLength DESC` → `recency DESC`. Rationale: structural signal (chain depth) strictly dominates arbitrary signal (recency) when effective priority is tied; an operator can trace "why this one?" as "longest chain → newest commit" without calibrating magic-number weights. The composition stays read-only for PPA per §5.3 (per-task scores in the calibration log are unchanged; only the dispatcher's sort is affected).

2. **Q2: What's the right graph artifact retention policy?** Snapshots accumulate in `$ARTIFACTS_DIR/_deps/`. Without retention, this grows unbounded. Lean: keep last 30 days + the snapshot at any RFC-significant event (major dispatch decision, calibration revision). Decide before Phase 1 ships. **Resolution (2026-05-01):** Option C — time-based rolling retention (30 days) + event-tagged permanent retention. Significant-event set: dispatch decisions, calibration revisions, RFC `Lifecycle` transitions. Snapshot writer reads an event tag on each call (`tag: 'rolling' | 'dispatch' | 'calibration' | 'lifecycle-transition'`); rolling-tagged snapshots are trimmed by mtime > 30d, the rest are kept indefinitely. Phase 1 must define a `cli-deps gc` command that does the rolling trim, and a `cli-deps inspect --tag <name>` to enumerate event-tagged snapshots so an operator can audit / prune the permanent tier when it grows. Storage growth on the permanent tier is bounded by event frequency × snapshot size; if either grows beyond expectations, a future revision can introduce per-tag caps (e.g. "keep last 100 dispatch snapshots, last 50 calibration snapshots") rather than redesigning the policy.

3. **Q3: How does the composition handle external dependencies?** A task may depend on something OUTSIDE the backlog system (e.g., "wait for npm version X to publish"). Lean: out of scope for v1; document the limitation. The graph models internal task dependencies only. Decide before Phase 1 ships. **Resolution (2026-05-01):** Option B — `externalDependencies:` frontmatter field, surfaced but not blocking. Task frontmatter gains an array of `{ id: string, description: string, kind: 'npm-version' | 'github-pr' | 'url-head' | 'manual' | 'other', resolverHint?: string }` entries. The snapshot writer renders these into `$ARTIFACTS_DIR/_deps/snapshot.*.jsonl` per task; the DoR comment template appends a "⚠ External dependencies tracked: N" line when present; the `cli-deps blockers` command surfaces them alongside internal blockers. Dispatcher behaviour is unchanged — externals are pure signal in v1. Rationale: capturing structurally avoids the placeholder-task anti-pattern (faking internal deps to a non-existent task just to register the wait), and pre-stages the data shape for a future v2 that adds resolver-driven enforcement (matches RFC-0011's resolver registry pattern). Cost is ~20 lines: parse + render. Decision to enforce (Option C/D) deferred until we have evidence that >30% of dispatch decisions are blocked by externals.

4. **Q4: What's the cost of recomputing the graph per dispatch?** AISDLC-117 ships an in-memory graph; recompute cost is O(V+E) which is trivial for our task counts. But if the dispatcher recomputes per dispatch decision (vs caching), per-decision overhead matters at scale. Lean: cache with a 30s TTL. Decide before Phase 2 ships. **Resolution (2026-05-01):** Option A — no cache; recompute every dispatch. Recompute is O(V+E) and sub-millisecond at current scale (~150 tasks, ~200 edges). YAGNI on caching: adding a TTL invites invalidation bugs (stale cache → wrong dispatch decision), an extra state surface to test, and operator confusion when manual edits don't show up immediately. Phase 2 ships without a cache; if profiling under realistic load later shows recompute dominating dispatch latency (>5% of decision time), revisit with measured evidence and design the cache strategy (B/C/D) on top of the data — not as a defensive default.

5. **Q5 (reframed 2026-05-01): How does DoR blast-radius interact with the maintainer `dor-bypass` override?** RFC-0011 §7.4 documents a maintainer-only `dor-bypass` label that short-circuits the DoR verdict to `ready (manual override by <maintainer>)` without running any gates. When such a bypass is used on a task with high blast radius, should the blast-radius callout still post (informational), or does the bypass suppress the comment entirely? Decide before Phase 3 ships. **Resolution (2026-05-01):** Option C — post a different, FYI-shaped comment on bypass. Standard admission verdicts get the existing "⚠ This issue currently gates N downstream tasks (...). Resolving the questions above unblocks the entire chain." template (per §6.2). Bypass-admitted high-radius tasks get a maintainer-tone variant: "ℹ This bypass admits a task gating N downstream items (AISDLC-X, AISDLC-Y, ...). Confirm intentional — high blast radius is a strong calibration signal that the rubric may be missing something." Different audience, different tone, same data. Pairs naturally with §7.4's per-maintainer override-rate metric: bypass-with-high-radius is a high-signal calibration data point that the rubric missed something. Phase 3 must define both comment templates + the trigger logic (admission verdict source determines which template fires).

   *Original Q5 wording referenced a "signal-pipeline auto-pass that skips gates 1, 4, 5, 6 (RFC-0011 Addition 1)" — that mechanism does not exist in RFC-0011 (§214 explicitly states "Stage A is always run, never skipped, never gated behind a flag"). Reframed to ask the real question about the `dor-bypass` maintainer override.*

6. **Q6: Does the graph snapshot need a write barrier with the Backlog.md adapter?** If the operator edits a task's `dependencies:` field while the dispatcher is reading the snapshot, what's the consistency model? Lean: snapshots are point-in-time; concurrent edits become visible at the next snapshot. No write barrier needed. Decide before Phase 1 ships. **Resolution (2026-05-01):** Option C — per-task atomic read with explicit "best-effort consistency, validated by consumer" contract. The snapshot computer walks `backlog/tasks/*.md` + `backlog/completed/*.md` sequentially and reads each file atomically (each `readFile` is OS-atomic), accepting that the resulting snapshot MAY include task A in pre-edit state and task B in post-edit state if an edit lands mid-walk. Dangling edges are caught by the consumer (`cli-deps validate` already does this per AISDLC-117) — they don't silently corrupt dispatch decisions. Rationale: Option A's "point-in-time" framing is a fiction at our scale (snapshot computation is multiple sequential disk reads, never truly atomic even without concurrent edits); C just acknowledges what the system already does. Avoids the cross-process flock fragility of B and the retry-storm risk of D, and stays honest about scaling — at larger task counts the read window grows linearly, so Option A's "stale by one tick" claim becomes "stale by N ticks" without anyone noticing. The contract is documented in `pipeline-cli/docs/dor.md` (or a new `pipeline-cli/docs/deps.md`) so consumers know to validate.

## 13. References

- RFC-0005 — Product Priority Algorithm (PPA scoring foundation)
- RFC-0008 — PPA Triad Integration
- RFC-0010 — Parallel Execution and Worktree Pooling (cli-status digest pattern)
- RFC-0011 — Definition-of-Ready Gate (DoR comment template + calibration log)
- AISDLC-117 — Compute backlog task dependency graph (`cli-deps` foundation)
- AISDLC-118 — RFC lifecycle convention (provides `Lifecycle:` field this RFC composes with)
- Original conversation with @dominique establishing the need (2026-05-01): "we have a dependency graph of the order the issues should be developed in. yet we aren't computing this dependency graph"
