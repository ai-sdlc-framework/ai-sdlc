---
id: AISDLC-256
title: 'Wire sweepMergedWorktrees() into cli-orchestrator tick loop — autonomous orchestrator bypasses Step 0 sweep'
status: To Do
assignee: []
created_date: '2026-05-10 09:35'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - dogfood
dependencies: []
priority: medium
references:
  - pipeline-cli/src/steps/00-sweep.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/execute-pipeline.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`sweepMergedWorktrees()` lives at `pipeline-cli/src/steps/00-sweep.ts` (Step 0 of the `/ai-sdlc execute` pipeline) and is called from `executePipeline()` at `pipeline-cli/src/execute-pipeline.ts:60`. Two other dispatch paths bypass it entirely:

1. **`cli-orchestrator tick`** (the autonomous loop) — `grep "sweep" pipeline-cli/src/orchestrator/*.ts` returns NO matches in `loop.ts`. Each tick scans the frontier and dispatches; merged worktrees from prior dispatches accumulate forever.
2. **Direct `Agent({subagent_type: 'developer'})` calls** in main session — bypass `executePipeline()` so no sweep.

## Witnessed (2026-05-10)

After 30+ autonomous-loop ticks and direct Agent dispatches over 3 days, operator's `.worktrees/` had **29 directories** for **27 already-merged PRs** + 2 genuinely-active worktrees. Operator complaint: "we have a ton of worktrees open."

Manual cleanup via `git worktree remove --force` × 27 cleared the backlog, but the underlying gap means accumulation will recur every dispatch session.

## Fix

Add a `sweepMergedWorktrees()` call to the orchestrator loop's per-tick prelude (i.e. before frontier scan):

```ts
// In pipeline-cli/src/orchestrator/loop.ts runOrchestratorTick()
import { sweepMergedWorktrees } from '../steps/00-sweep.js';

export async function runOrchestratorTick(...) {
  // Existing self-heal + frontier scan
  await sweepMergedWorktrees({ workDir: config.workDir, runner: adapters.runner });
  ...
}
```

Sweep is idempotent + parallel-safe (per `00-sweep.ts:14` docstring). Cost is one `gh pr list --head <branch> --state all` per worktree — typically 0-5 worktrees per active session, so ~1-5 gh API calls per tick.

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 `pipeline-cli/src/orchestrator/loop.ts` `runOrchestratorTick()` calls `sweepMergedWorktrees()` before the frontier scan
- [ ] #2 Failure of the sweep does NOT abort the tick — wrap in try/catch + log warning, continue with frontier scan
- [ ] #3 Integration test: after a tick that observes a merged-PR worktree, the worktree directory is removed and `git worktree list` no longer shows it
- [ ] #4 Operator-visible verification: after merging a PR while `cli-orchestrator tick` is running, the next tick's events.jsonl shows a `OrchestratorWorktreeSwept` event (or equivalent)
- [ ] #5 Documented in `pipeline-cli/docs/orchestrator.md` — autonomous loop now self-cleans merged worktrees
<!-- SECTION:ACCEPTANCE:END -->

## Why not also fix the Agent-tool path

Direct `Agent({subagent_type: 'developer'})` calls bypass everything (no executePipeline, no orchestrator loop). The fix for that path is to NOT use Agent directly — use `/ai-sdlc execute` (slash command body, has Step 0 sweep) or wait for the autonomous orchestrator to be promoted to default-on (then Agent calls are unnecessary). This task only addresses the orchestrator loop gap.
<!-- SECTION:DESCRIPTION:END -->
