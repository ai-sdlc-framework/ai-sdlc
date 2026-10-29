---
id: AISDLC-831
title: >-
  PRs closed unmerged and re-filed are a tracked waste KPI in the quality corpus and the dispatch digest
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - metrics
  - velocity
dependencies: []
references:
  - pipeline-cli/bin/cli-quality-corpus.mjs
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-13 02:40Z).** "Every closed PR means wasted work ... we need to track this in the KPIs." Today #1434 and #1437 (AISDLC-823) were closed unmerged and replaced; each carried a filing, CI runs and operator attention that produced nothing. The framework records review cost, DoR outcomes and gate audits, but nothing counts PRs that end closed instead of merged, so the waste is invisible and recurs.

**Five-step review (requirements first).** Nothing to delete: this adds one counter to an existing corpus and one line to an existing digest (step 2).
1. Requirement questioned: "velocity is measured by PRs landed" (implicit in the corpus aggregators). Landed PRs hide the ones thrown away; the operator wants waste visible.
2. Delete: nothing.
3. Simplify: one metric, `prs-closed-unmerged`, per week and per cause where known (`re-filed` when a later PR names the same task id; `superseded`; `withdrawn`; `unknown`), computed from `gh pr list --state closed` (merged == null) in the quality corpus aggregator, with the task id parsed from branch or title. The dispatch progress line and the planner handoff show the running count for the current drain.
4. Accelerate: a re-file is visible the same day, so the planner names the avoidable cause (memory rule) and the fix is filed at once.
5. Automate: the corpus already runs on its schedule; no new job.

**Velocity impact.** Positive by visibility; the metric itself costs one API call per run.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `cli-quality-corpus aggregate` emits `prs-closed-unmerged` with total and per-cause counts for the window, with the PR numbers and task ids listed; hermetic test on a fixture of closed PRs
- [x] #2 A closed PR followed by an open or merged PR for the same task id within the window is classified `re-filed`
- [x] #3 The dispatch tick result and its progress line carry `closedUnmerged: <n>` for the current drain window, read from the same classifier
- [x] #4 `docs/operations/` KPI page (or the quality corpus doc) defines the metric and states that the target is zero
- [x] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
