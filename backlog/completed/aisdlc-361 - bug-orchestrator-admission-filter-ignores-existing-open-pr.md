---
id: AISDLC-361
title: 'bug(orchestrator): admission filter ignores existing open PR for branch — admits task, aborts at Step 3 worktree-create, burns tick slot'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - orchestrator
  - admission-filter
  - pipeline-friction
  - autonomous-loop-blocker
  - high
dependencies: []
priority: high
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/steps/03-setup-worktree.ts
---

## Bug

Observed during 2026-05-17 operator-away autonomous loop. Per filter trace:

```
[orchestrator] filter trace for AISDLC-287:
  - Orphan-parent check: passed
  - Already-in-flight check: passed   ← ignores PR #521
  - Dependency check: passed
  - Blast-radius overlap check: passed
  - Dispatchability check: passed
  - DoR readiness: passed
  - External deps: passed
  - Operator-blocked check: passed
  - Captures-pending check (RFC-0024): passed
  → admitted
[ai-sdlc-progress] execute: task=AISDLC-287 spawner=claude
...
[step-3] aisdlc-287: keeping branch (open PR #521 for branch ai-sdlc/aisdlc-287-...)
[ai-sdlc-progress] execute: rollback partial status=true worktree=false quarantined=false
```

The "already-in-flight" filter checks the worktree sentinel + git branch existence, but does NOT query GitHub for open PRs by branch name. Result: same 2 tasks (AISDLC-284, AISDLC-287) are re-admitted every tick + aborted at Step 3 because `detectDraftPrForBranch` (called by Step 3) finds the existing open PR.

## Repro

1. Open a PR via the orchestrator for task AISDLC-N
2. Leave the PR open (e.g., it's stuck in queue due to AISDLC-360 v4-kick loop, or has unaddressed reviewer findings)
3. Run `cli-orchestrator tick --spawner claude --max-concurrent 2`
4. Observe: task AISDLC-N is admitted + aborted in every subsequent tick

The orchestrator's `--max-concurrent 2` slots are eaten by re-admitting the same blocked tasks, preventing new dispatch.

## Impact

- Autonomous-loop deadlock when 2+ tasks have stuck PRs (no slot for new dispatch)
- Operator burns cycles on noisy `[execute: outcome=aborted iterations=0]` events
- Wasted claude -p invocations (the orchestrator at least bails at Step 3 before spawning the dev, so no LLM cost — but still consumes tick wall time)

## Acceptance criteria

- [ ] **In `runOrchestratorTick`'s filter chain**, add a new filter `OpenPullRequestExists` that runs BEFORE `Already-in-flight`:
   - Computes the canonical branch name (`pipeline-cli/src/steps/02-compute-branch.ts`)
   - Queries `gh pr list --head <branch> --state open --json number,isDraft`
   - If a PR exists: skip with `→ skipped, open PR #<n> already exists for branch <name>` 
- [ ] **Cache the gh pr list result** within a single tick (avoid N+1 calls when filter runs for many candidates)
- [ ] **Test**: pre-populate a worktree + open PR for a task; run filter chain; assert task is skipped with the new reason
- [ ] **Add events.jsonl emission**: `OrchestratorBlockedByOpenPullRequest {taskId, prNumber, prState}` so operators can see how often this fires
- [ ] **Filter trace UX**: when this filter fires, include the PR URL so operator can click through directly

## Out of scope

- Auto-recovering the open PR (re-rebase, re-sign) — that's AISDLC-360's domain
- Auto-closing the open PR — never close PRs (project rule)
- Detecting WHY the PR is stuck — separate observability concern

## Source

Operator-away loop session 2026-05-17. The autonomous tick admitted AISDLC-287 + AISDLC-284 across **8+ consecutive tick cycles** without making any new progress, because PR #521 (287) was stuck in AISDLC-360's v4-kick loop and PR #524 (284) needed operator review for real MAJOR findings.

Pairs with:
- AISDLC-360 (v4 kick loop — root cause for 287 being stuck)
- AISDLC-359 (degenerate reviewer — root cause for 524 being stuck)
- AISDLC-358 (parent-on-main guard — orthogonal but same operator-away loop)
