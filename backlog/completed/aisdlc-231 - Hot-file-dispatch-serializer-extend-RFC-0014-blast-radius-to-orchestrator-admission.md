---
id: AISDLC-231
title: >-
  Hot-file dispatch serializer — extend RFC-0014 blast-radius to orchestrator
  admission, not just DoR
status: Done
assignee: []
created_date: '2026-05-07 21:35'
labels:
  - enhancement
  - orchestrator
  - rfc-0014
  - rfc-0015
  - framework-bug
  - dogfood
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/orchestrator/filters/
  - pipeline-cli/src/dor/blast-radius.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

RFC-0014 Phase 3 ships **DoR blast-radius** — for each task, compute the set of files it likely touches. Today this is consumed only as a **DoR signal** (flag overlapping tasks for human triage at the Definition-of-Ready gate). It is NOT consumed by the orchestrator's dispatch admission cascade.

Result: when N tasks all touch the same shared file (e.g. `shared/types.ts`, an enum companion map, a registry), they can ALL be admitted in parallel by `cli-orchestrator tick --max-concurrent N`. Each agent's worktree is rebased onto `origin/main` at agent-launch time. As earlier agents land, later agents are working against an increasingly stale main. When a stale agent's commit lands, it includes its OWN re-derivation of work that's already on origin (different code, same intent), causing massive merge conflicts.

## Witnessed empirically

Reported by Alex in the forge repo (2026-05-07, see operator's "ai-sdlc plugin feedback for Dom.md"):

> "TASK-658 cherry-pick blew up with 14 'both added/modified' conflicts. The agent's worktree had been rebased before TASK-654/656/657/664 landed; by the time TASK-658 finished, the agent's commit re-derived all of those (with subtly different formatting/structure)."

> "TASK-656 fleet added 12 EntityType enum members but didn't extend ENTITY_SOURCE_MAP / ENTITY_ONTOLOGY / KnowledgeTrunk taxonomy. Test failures only caught it. Without our exhaustive integrity tests, would've shipped silent-leak."

The companion-map invariant is a separate concern (filed elsewhere). The stale-rebase fan-out is what this task addresses.

## Why this matters now

RFC-0015's vision is autonomous unattended orchestration — operator AFK, orchestrator dispatches in parallel. With no human in the loop to triage the DoR blast-radius flag, parallel dispatch on overlapping tasks WILL produce stale-rebase collisions on the regular. We can either accept the cost (escalate every conflict to operator) or serialize.

## Proposed design

### New filter: `BlastRadiusOverlapFilter`

Add to `pipeline-cli/src/orchestrator/filters/blast-radius-overlap.ts`. Place it AFTER `OrphanParentFilter` + `DependencyReadinessFilter` but BEFORE `AlreadyInFlightFilter` (AISDLC-227) in the chain.

```typescript
export class BlastRadiusOverlapFilter implements PipelineFilter {
  readonly name = "BlastRadiusOverlap";
  async check(task: TaskRecord, ctx: FilterContext): Promise<FilterResult> {
    const candidateBR = await ctx.blastRadius.compute(task.id);
    if (candidateBR.files.length === 0) {
      return { admitted: true, reason: "no blast-radius files declared" };
    }
    // Find all in-flight tasks (open PRs + active worktrees)
    const inFlightTaskIds = await ctx.inFlightDetector.list();
    for (const inFlightId of inFlightTaskIds) {
      const inFlightBR = await ctx.blastRadius.compute(inFlightId);
      const overlap = intersect(candidateBR.files, inFlightBR.files);
      if (overlap.length > 0) {
        return {
          admitted: false,
          reason: `hot-file overlap with in-flight ${inFlightId}: ${overlap.slice(0, 3).join(", ")}${overlap.length > 3 ? "…" : ""}`,
        };
      }
    }
    return { admitted: true };
  }
}
```

### Tradeoffs

- **False positives** — two tasks both edit a 1000-line file but in different sections. Today's RFC-0014 chose to defer to humans. This filter would over-serialize. Mitigations:
  1. Allow operator override via `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=1` env (escape hatch)
  2. Tighten blast-radius to symbol/section level in a follow-up (out of scope here)
  3. Combine with AISDLC-232 (late-rebase in Step 11) so over-serialization cost is bounded

- **Throughput cost** — strict serialization on hot files reduces parallelism. But the alternative (rebase-fan-out cleanup) is worse.

- **Detection accuracy** — depends on RFC-0014 Phase 3's blast-radius being trustworthy. Phase 5's corpus-driven calibration is what makes this reliable; until that lands, this filter's gating decisions need observability + override.

## Acceptance Criteria

- [ ] #1 New `BlastRadiusOverlapFilter` lives in `pipeline-cli/src/orchestrator/filters/blast-radius-overlap.ts` and is registered in the filter chain after `DependencyReadinessFilter` and before `AlreadyInFlightFilter`
- [ ] #2 Filter consults RFC-0014 Phase 3's blast-radius computation (`pipeline-cli/src/dor/blast-radius.ts` or successor) for both candidate task and each in-flight task
- [ ] #3 In-flight set sourced from: (a) open PRs whose `head` matches a task-id-derived branch pattern, (b) `.worktrees/<task-id>/.active-task` sentinels — same source as AISDLC-227's `AlreadyInFlightFilter`
- [ ] #4 On overlap detected, filter returns `admitted: false` with a `reason` field listing up to 3 overlapping file paths plus the in-flight task ID
- [ ] #5 Env override `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=1` skips the filter entirely (operator escape hatch); env override `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK=<task-id>` skips ONLY for the named task (per-task escape)
- [ ] #6 `cli-orchestrator tick` trace output includes per-filter results so operators can debug "why didn't task X dispatch this tick"
- [ ] #7 Hermetic tests: stub blast-radius + in-flight detector with fixtures covering: (a) no overlap → admitted, (b) overlap with one in-flight task → blocked, (c) overlap with N in-flight tasks → blocked, citing first one, (d) candidate has empty blast-radius → admitted (degrade-open), (e) bypass env set → admitted regardless
- [ ] #8 Documents the filter behavior in `docs/operations/orchestrator-runbook.md` under "How the orchestrator decides which task to dispatch"
- [ ] #9 Composes with AISDLC-227 (in-flight detector) and AISDLC-232 (late-rebase in Step 11) — the trio together is the parallel-orchestrator-safety batch

## Composes with

- **AISDLC-167** (RFC-0014 Phase 3 base) — provides the blast-radius data this filter consumes
- **AISDLC-227** (in-flight detection filter) — provides the in-flight task set
- **AISDLC-232** (late-rebase in Step 11) — bounds the cost of any stale-rebase that slips through (e.g. when blast-radius is incomplete)
- **AISDLC-228** (Step 3 quarantine guard) — together makes parallel dispatch genuinely safe

## References

- `pipeline-cli/src/orchestrator/filters/` (filter chain home)
- `pipeline-cli/src/dor/blast-radius.ts` (blast-radius source — name approximate)
- `spec/rfcs/RFC-0014-dependency-graph-composition.md` (§Phase 3 blast-radius)
- `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md` (admission cascade where this fits)
- Operator's "ai-sdlc plugin feedback for Dom.md" 2026-05-07 — Alex's report from the forge repo
- AISDLC-227 (sister filter — same chain layer)
- AISDLC-228 (sister hardening — same parallel-safety batch)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 BlastRadiusOverlapFilter added + registered after DependencyReadinessFilter, before AlreadyInFlightFilter
- [ ] #2 Filter consults RFC-0014 Phase 3 blast-radius for candidate + each in-flight task
- [ ] #3 In-flight set sourced from open PRs + .active-task sentinels (shared with AISDLC-227)
- [ ] #4 Overlap returns admitted:false + reason listing top-3 file paths + in-flight task ID
- [ ] #5 Env overrides: global bypass + per-task bypass for operator escape
- [ ] #6 Tick trace includes per-filter results
- [ ] #7 Hermetic tests cover 5 paths (no-overlap, single-overlap, multi-overlap, empty-BR, bypass)
- [ ] #8 Operator runbook documents the filter
- [ ] #9 Composes with AISDLC-227 + AISDLC-232 as the parallel-orchestrator-safety batch
<!-- SECTION:ACCEPTANCE:END -->
