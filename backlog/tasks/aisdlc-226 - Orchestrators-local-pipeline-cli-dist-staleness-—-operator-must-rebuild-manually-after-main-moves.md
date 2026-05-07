---
id: AISDLC-226
title: >-
  Orchestrator's local pipeline-cli/dist staleness — operator must rebuild
  manually after main moves
status: To Do
assignee: []
created_date: '2026-05-07 02:23'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - framework-bug
  - dogfood
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`cli-orchestrator tick` runs from the parent's `pipeline-cli/dist/` compiled JS. When `main` moves (new merges land), the parent's working tree is reset via `git reset --hard origin/main` but `dist/` is gitignored — it stays at whatever the LAST manual `pnpm build` produced.

Result: the orchestrator silently runs OLD code. Filters, spawners, event types — anything compiled — can be stale by N commits.

**Witnessed empirically 2026-05-07** (operator-driven dogfood): orchestrator's `runFilterChain` was missing the `BlockedFilter` (AISDLC-223). The frontmatter-blocked AISDLC-115 task was admitted + dispatched even though we'd marked it `blocked.reason: "soaking..."`. Trace showed only 4 filters — `Operator-blocked check` was absent. Manual `pnpm --filter @ai-sdlc/pipeline-cli build` produced the missing filter and fixed it.

This is a SHIP-blocking dogfood bug for unattended orchestrator operation. Without the auto-rebuild, every operator who pulls main must remember to rebuild OR the orchestrator silently skips filters/features that have shipped.

## Proposed design

### Option A — auto-rebuild at tick start

`cli-orchestrator tick` (or `start`) checks if `dist/` is older than the most-recent `src/` mtime. If yes, run `pnpm --filter @ai-sdlc/pipeline-cli build` before proceeding.

Cost: adds 5-10s to first tick after a pull. Acceptable for unattended use.

Pros: bulletproof — operator doesn't need to remember.
Cons: pipeline-cli has to know how to invoke its own build. Brittle if package layout changes.

### Option B — skip dist entirely; tsx at runtime

Have the orchestrator binary use `tsx` to import `src/` directly. No build step needed.

Pros: simpler, no staleness risk.
Cons: cold-start time per tick (~1-2s). Tier 1 / slash command body would also need to switch.

### Option C — Step 0 self-heal extension

`scripts/check-orchestrator-state.sh` (already runs on dispatch from Pattern C parent) gains a stale-dist check. If `dist/` is older than `src/`, run rebuild.

Pros: piggybacks on existing self-heal infrastructure. Doesn't change orchestrator runtime.
Cons: only fires on `/ai-sdlc execute` dispatches, not direct `cli-orchestrator tick` invocations.

**Recommendation:** Option A (auto-rebuild at tick start) — simplest correctness + matches the autonomous-operation goal.

## Acceptance Criteria

- [ ] #1 `cli-orchestrator tick` (and `start`) detect stale `pipeline-cli/dist/` (newest src mtime > newest dist mtime) and rebuild before proceeding
- [ ] #2 Rebuild logs to stderr with a clear `[orchestrator] dist/ stale, rebuilding pipeline-cli` line so operators see what happened
- [ ] #3 If rebuild fails, abort the tick with a clear error (don't silently proceed with stale dist)
- [ ] #4 Skip env: `AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1` for cases where the operator knows dist is fresh (CI, packaged binaries)
- [ ] #5 Hermetic test: fixture with src newer than dist → rebuild fires; src older than dist → rebuild skipped
- [ ] #6 `docs/operations/orchestrator-runbook.md` documents the auto-rebuild behavior + the skip env

## Composes with / supersedes

- Composes with **AISDLC-225** (inline spawner consumer bridge) — both gaps block real unattended orchestrator operation
- Composes with **AISDLC-224** (stale-branch auto-cleanup) — same self-heal philosophy: orchestrator should recover from common operator-state issues on its own

## References

- `pipeline-cli/src/orchestrator/loop.ts` (where rebuild check would land)
- `scripts/check-orchestrator-state.sh` (existing self-heal pattern to mirror)
- AISDLC-223 (BlockedFilter — the witness for this bug)
<!-- SECTION:DESCRIPTION:END -->
