---
id: AISDLC-825
title: >-
  Decisions filed from a task worktree land in the parent catalog so dispatch can route them
status: To Do
assignee: []
created_date: '2026-10-12'
labels:
  - decisions
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/bin/cli-decisions.mjs
  - pipeline-cli/src/decisions/index.ts
  - pipeline-cli/src/steps/00-5-sync-parent.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (verified 2026-10-12, DEC-0153 through DEC-0156).** An executor that escalates runs `cli-decisions add` from its task worktree (`.worktrees/<id>/`). The event file lands in `<worktree>/.ai-sdlc/_decisions/events/`, untracked. Dispatch, running in the parent checkout, cannot `cli-decisions show` it and cannot route it; four blocked verdicts today cited a decision id that "does not exist". The planner located each by hand in the source worktree. Copying the files into the parent then made them untracked there, and Step 0.5 (`00-5-sync-parent.ts`, non-backlog untracked files) refused the next fresh execute (DEC-0155), which cost a filing PR (#1440). The verdict already carries `decisionIds` but not where the events live.

**Five-step review (requirements first).** Delete: the per-worktree catalog as a destination for executor escalations (step 2).
1. Requirement questioned: "a decision event is written to the catalog of the checkout the command runs in" (implicit default of `cli-decisions`, nobody chose it). The catalog that matters is the one dispatch and the planner read: the parent's, and ultimately `main`.
2. Delete: the per-worktree catalog as a destination for executor escalations. Nothing else reads it.
3. Simplify: `cli-decisions` resolves the catalog root to the main checkout when invoked from a linked worktree (`git rev-parse --git-common-dir` gives it), so `add`, `answer` and `show` agree wherever they run. The event files still reach `main` the way they do today (filing PRs, or committed in a task branch); the parent copy is exactly what a later fast-forward brings, so Step 0.5 treats `.ai-sdlc/_decisions/events/` as a parent-tolerated untracked path.
4. Accelerate: removes one executor→dispatch→planner round trip per escalation and the filing PR per batch.
5. Automate: none.

**Velocity impact.** Positive: four round trips and one PR saved today alone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-decisions add|answer|show|list` run from `.worktrees/<id>/` read and write `<main checkout>/.ai-sdlc/_decisions/events/`; hermetic test with a real linked worktree
- [ ] #2 A blocked verdict whose `decisionIds` were filed from the worktree is routable by dispatch with `cli-decisions show <id>` from the parent, with no manual copy
- [ ] #3 Step 0.5 does not refuse an execute because of untracked files under `.ai-sdlc/_decisions/events/`; test in `00-5-sync-parent.test.ts`
- [ ] #4 `docs/operations/decision-authority.md` states where decision events live and how they reach `main`
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
