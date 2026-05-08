---
id: AISDLC-227
title: >-
  Orchestrator lacks in-flight detection — re-dispatches tasks with open PR or
  active worktree
status: Done
assignee: []
created_date: '2026-05-07 02:26'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - framework-bug
  - dogfood
dependencies: []
priority: high
---

## Final Summary

## Summary

Shipped `AlreadyInFlightFilter` (`pipeline-cli/src/orchestrator/filters/already-in-flight.ts`), a new pre-dispatch filter that prevents `cli-orchestrator tick` from re-dispatching tasks that are already being processed. The filter checks three signals — open PR, active worktree sentinel, and live `claude --print` subprocess — before the dependency readiness walk and short-circuits on the first hit. The witness was AISDLC-202.2 (PR #402 already open) wasting ~30s of tick overhead per attempt.

## Changes

- `pipeline-cli/src/orchestrator/filters/already-in-flight.ts` (new): Three-signal in-flight detector with injectable `listOpenPRs` and `readProcessTable` for hermetic testing; subprocess detection behind `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS` env var (default ON)
- `pipeline-cli/src/orchestrator/filters/already-in-flight.test.ts` (new): 18 hermetic tests covering all 3 detection paths, negative path, signal priority, env var gating, and error-swallowing
- `pipeline-cli/src/orchestrator/filters/types.ts` (modified): Added `AlreadyInFlight` to `FilterName` union; added `AlreadyInFlightDetail` to `FilterDetail` union
- `pipeline-cli/src/orchestrator/filters/chain.ts` (modified): Inserted `AlreadyInFlight` filter BEFORE `DependencyReadiness`; added `alreadyInFlightOpts` to `RunFilterChainOpts`; added human name + terminal note for the new filter
- `pipeline-cli/src/orchestrator/filters/chain.test.ts` (modified): Updated all chain tests for 6-filter trace, added `noInFlight()` stub helper, added already-in-flight short-circuit test
- `pipeline-cli/src/orchestrator/filters/index.ts` (modified): Exported `checkAlreadyInFlight` and `CheckAlreadyInFlightOpts`
- `pipeline-cli/src/orchestrator/loop.ts` (modified): Added `already-in-flight` case to `toBlockedEvent` switch (returns null; events handled separately via `alreadyInFlightEvents`)
- `docs/operations/orchestrator-runbook.md` (modified): New "In-flight detection" section documenting the 3 signals, trace output, and recovery steps

## Design decisions

- **Filter position AFTER OrphanParent, BEFORE DependencyReadiness**: gh call + existsSync are O(1) local checks; the worktree clash cost (~30s setup) far outweighs them. OrphanParent stays first because it's pure in-memory.
- **Subprocess detection behind env var**: `ps -ax` is more invasive than a gh call; operators can opt out via `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS=0`. Default is ON for tick/start — most users want the protection.
- **Injectable callbacks for testability**: `listOpenPRs` and `readProcessTable` replace real subprocess calls in tests; all 18 tests are fully hermetic (no network, no real `gh`/`ps`).
- **gh failure is silent skip**: A transient gh network error should NOT block dispatch — we degrade gracefully to signals (b) and (c).

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 2352 tests passed (149 suites)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up

- AISDLC-225: once the inline spawner consumer bridge lands, signal (c) can be extended to detect manifests written by `ClaudeCliInlineSpawner` as a fourth signal

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`cli-orchestrator tick` currently selects a task from the dispatch-ready frontier and starts a new pipeline run for it WITHOUT first checking:

- Is there already an open PR for this task ID?
- Is there already a `.worktrees/<task-id>/` directory with a `.active-task` sentinel?
- Is there already a `claude --print` subprocess running for this task?

Result: under merge-queue latency or cross-session orchestrator runs, the orchestrator dispatches a duplicate pipeline against a task that is already in flight. Operator must manually kill the redundant subprocess + clean up the duplicate worktree.

**Witnessed empirically 2026-05-07** (operator-driven dogfood): orchestrator ticked while AISDLC-178.4 was sitting in the merge queue with PR #384 open. Filter chain didn't catch it (no AlreadyDispatched filter exists). The orchestrator allocated a worktree, wrote `.active-task`, and started a `claude -p` developer subprocess for AISDLC-178.4 — duplicate of the one whose PR was awaiting merge. Operator killed the subprocess + ran `git worktree remove --force` to recover.

This is a SHIP-blocking dogfood bug for unattended orchestrator operation. Without in-flight detection, every tick that races a slow-merging PR or a still-running dev subprocess in another session will produce a duplicate dispatch.

## Proposed design — new `AlreadyInFlightFilter`

Add to `pipeline-cli/src/orchestrator/filters/` after `OrphanParentFilter`, before `DependencyReadinessFilter`:

```typescript
export class AlreadyInFlightFilter implements PipelineFilter {
  readonly name = "AlreadyInFlight";
  async check(task: TaskRecord, ctx: FilterContext): Promise<FilterResult> {
    // (a) Open PR on this task ID
    const openPRs = await ctx.gh.listOpenPRs({ headPrefix: `ai-sdlc/${task.idLower}-` });
    if (openPRs.length > 0) {
      return { admitted: false, reason: `PR #${openPRs[0].number} already open` };
    }
    // (b) Active worktree with sentinel
    const wtPath = path.join(ctx.repoRoot, ".worktrees", task.idLower);
    if (await fileExists(path.join(wtPath, ".active-task"))) {
      return { admitted: false, reason: `worktree ${wtPath}/.active-task exists` };
    }
    // (c) Live developer subprocess (best-effort: pgrep claude -p with task-id in argv)
    if (await ctx.processProbe.findClaudePForTask(task.id)) {
      return { admitted: false, reason: `claude -p subprocess already running for ${task.id}` };
    }
    return { admitted: true };
  }
}
```

### Tradeoffs

- (a) and (b) are CHEAP — local filesystem + cached gh PR list per tick. Always run.
- (c) is more invasive (process-table scan); behind `--detect-running-subprocesses` flag, default ON for `tick`, OFF for hermetic tests.

### Why a filter, not a Step 0 self-heal

Self-heal would QUIETLY skip + log; a filter trace makes it visible in `cli-orchestrator tick` output why a task was filtered. Operators can then debug "why didn't 178.5 dispatch this tick" by reading the trace.

## Acceptance Criteria

- [ ] #1 New `AlreadyInFlightFilter` added to `pipeline-cli/src/orchestrator/filters/already-in-flight.ts` and registered in the filter chain (between `OrphanParentFilter` and `DependencyReadinessFilter`)
- [ ] #2 Filter checks: (a) open PR matching `ai-sdlc/<task-id-lower>-*`, (b) `.worktrees/<task-id-lower>/.active-task` exists, (c) live `claude -p` subprocess with task ID in argv
- [ ] #3 Tick trace logs each filter result distinctly: `Already-in-flight check: failed (PR #384 open)` etc.
- [ ] #4 Hermetic test: stub gh + filesystem fixtures cover all 3 detection paths
- [ ] #5 Process-probe path uses `ps -ax -o pid,command | grep "claude .*--print.*<task-id>"` (Darwin/Linux portable); behind env `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS=1`, default on for `tick` and `start`
- [ ] #6 Documents the filter in `docs/operations/orchestrator-runbook.md` under "How the orchestrator decides which task to dispatch"
- [ ] #7 No regression: existing `BlockedFilter`, `OrphanParentFilter`, `DependencyReadinessFilter`, `DorReadinessFilter`, `ExternalDependenciesFilter` all still fire

## Composes with / supersedes

- Composes with **AISDLC-226** (stale-dist auto-rebuild) — both are in-tick admission cascade hardening, ship together
- Composes with **AISDLC-225** (inline spawner consumer bridge) — once that lands, the process-probe detection (filter step c) extends to detect inline spawner manifests too
- Composes with **AISDLC-117** (`cli-deps preflight`) — preflight catches dependency cycles; this catches dispatch cycles

## References

- `pipeline-cli/src/orchestrator/filters/chain.ts` (filter chain registration)
- `pipeline-cli/src/orchestrator/filters/blocked.ts` (sister filter, BlockedFilter from AISDLC-223 — closest analogue)
- `ai-sdlc-plugin/skills/execute/SKILL.md` Step 3 (this is what the slash-command body does today: refuses to start if branch already exists. Filter generalises that check to PR + worktree + subprocess.)
- AISDLC-104 (the original duplicate-dispatch incident that motivated the `cli-deps preflight` gate)
- Witnessed dogfood incident 2026-05-07 with AISDLC-178.4
<!-- SECTION:DESCRIPTION:END -->
