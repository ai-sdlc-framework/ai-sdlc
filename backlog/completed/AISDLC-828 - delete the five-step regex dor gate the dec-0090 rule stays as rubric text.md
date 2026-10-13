---
id: AISDLC-828
title: >-
  Delete the five-step regex DoR gate; the DEC-0090 rule stays as rubric text
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - dor
  - velocity
dependencies: []
references:
  - pipeline-cli/src/dor/gates/five-step-review.ts
  - .github/workflows/dor-ingress.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Authority:** DEC-0158 (operator, 2026-10-13, class (b) weakening, option `delete-gate`; the event files land on main in the same PR as this task, #1447, and the task is dispatched only after that PR has landed).

**Context.** AISDLC-804 (#1394, 2026-10-12) added `checkFiveStepReview` (`pipeline-cli/src/dor/gates/five-step-review.ts`) to DoR Gate 2: a task labelled `fix`/`bug`/`ci`/`root-cause`/`governance`/`hooks`/`stability`, or titled `fix…`, must contain a `**Five-step review` paragraph that contains the word delete/deleted/deletion or "nothing to delete", or `Evaluate backlog tasks changed by PR` and `DoR readiness (task-file PRs)` fail and `ai-sdlc/pr-ready` goes red. The check verifies the presence of a keyword, not the thinking DEC-0090 asks for; "nothing to delete" satisfies it as well as a real deletion. Its paragraph regex (line 38) also uses the `m` flag, so `$` matches the end of the heading line and only that line is inspected. On 2026-10-12 it blocked four correctly written tasks (#1447) for a CI cycle and has caught no missing deletion.

**Five-step review (requirements first).** Delete: `checkFiveStepReview`, `requiresFiveStepReview`, `FIVE_STEP_LABELS`, `FIVE_STEP_QUESTION`, their Gate-2 wiring and tests.
1. Requirement questioned: "fix and rule tasks show five-step thinking" (DEC-0090, operator). Kept, as a rule in CLAUDE.md and as DoR rubric text the planner and the Stage-B refinement reviewer apply with judgment.
2. Delete: the deterministic regex gate named above. Step 5 (automate) was applied before the discipline it automates had settled, which DEC-0090 itself says not to do.
3. Simplify: nothing further; the rubric text already exists.
4. Accelerate: one false-negative CI round per filing PR disappears.
5. Automate: none.

**Velocity impact.** Positive.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `pipeline-cli/src/dor/gates/five-step-review.ts` and its test file are deleted; Gate 2 no longer calls `checkFiveStepReview`; no other import remains (`pnpm dark-code:check` and the build pass)
- [x] #2 A task with `fix` in its title and no five-step paragraph evaluates with no Gate-2 finding about the five-step paragraph (regression test on the Gate-2 suite)
- [x] #3 The DoR rubric text (refinement-reviewer prompt or `docs/operations/` DoR page) still asks for the five-step paragraph as judgment, and CLAUDE.md's "Five-step production algorithm" section is unchanged except that it no longer claims a deterministic check enforces it (if it does)
- [x] #4 The task body carries its own five-step paragraph
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test && pnpm dark-code:check`
- `pnpm lint && pnpm format:check`
