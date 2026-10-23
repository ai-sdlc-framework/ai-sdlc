---
id: AISDLC-1053
title: 'A reenter can force a developer round: the resume note reaches the developer instead of being skipped on an unchanged patch id'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - pipeline-cli
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/dispatch/types.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Context (dispatch and planner finding, 2026-10-23 ~05:35Z).** PR #1907 was red on patch coverage only, with a missing test as the cause. Dispatch reentered the task with a resume note that began `DEVELOPER ROUND REQUIRED` and named the test to add. The executor's `next-step` took `review-skipped: unchanged`: the resume decision (`pipeline-cli/src/next-step/resume-decision.ts`) compares the current patch id with the newest attested envelope and, when they are equal, runs neither developer nor reviewers and goes straight to reconcile and re-sign. The note was never shown to a developer, the test was not added, the PR stayed red, and the push then failed non-fast-forward. The same shape produced a silent no-op resume earlier in the day. Today the only path to new code on an open PR is a fresh task whose manifest carries `fixesPr`, rewritten by hand to the PR's branch.

**Root cause.** The resume decision has no input for "the operator wants a developer round"; the resume note is audit text that reaches nobody who can act on it.

**Five-step review (requirements first).**
1. Requirement questioned: should an unchanged patch id ever skip the developer? Yes by default: it is the cheap path for a rebase or re-sign. But a reenter that asks for new code must be able to say so in data, not prose.
2. Delete: nothing; the unchanged branch stays the default.
3. Simplify: one flag, `cli-dispatch reenter ... --developer-round`, that sets `resume.developerRound: true` on the manifest (type in `pipeline-cli/src/dispatch/types.ts`). When it is set, `next-step` bypasses the unchanged shortcut, builds the Step 5 developer prompt with the resume note as the reviewer feedback block (the Step 9 iterate path already does this for reviewer findings), and then takes the normal delta review on the new patch id. Without the flag, behaviour is unchanged.
4. Accelerate: `cli-dispatch reenter` prints which path the next resume will take (`unchanged`, `delta`, `full`, or `developer-round`) so dispatch sees in the command output that a note will or will not be acted on, instead of learning it from a failed verdict.
5. Automate: a unit test on the resume decision with `developerRound: true` and an equal patch id asserts the developer branch; a second test asserts the flag is cleared once the developer round has run, so a later resume of the same manifest takes the normal path; `docs/operations/cli-hierarchy.md` documents the flag and the printed path.

**Velocity impact.** Positive: a red that needs code is fixed by one reenter instead of a hand-rewritten `fixesPr` manifest and a second task.

## Acceptance Criteria

- [x] `cli-dispatch reenter --developer-round` sets `resume.developerRound: true`; the manifest type carries the field.
- [x] With the flag set and an unchanged patch id, `next-step` runs the developer with the resume note as feedback, then the delta review; without the flag, behaviour is unchanged (existing tests still pass).
- [x] The flag is consumed after the developer round so the next resume takes the normal path; a test covers it.
- [x] `cli-dispatch reenter` prints the resume path the next run will take.
- [ ] `docs/operations/cli-hierarchy.md` documents the flag; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
Addressed the round 1 review findings. I added a next-step machine test: a resumed task with the flag set runs the developer, clears `resume.developerRound`, then reviews. I added a CLI test for the printed `resumePath`. I removed the vacuous resume-decision test, made `reenter` warn on stderr when `--developer-round` is ignored, and replaced the `as unknown as NextStepContext` cast in `predictResumePath` with narrowed `Pick<NextStepContext, 'workDir' | 'runner'>` types. I did not push.

## Changes
- pipeline-cli/src/cli/dispatch.ts
- pipeline-cli/src/cli/dispatch.test.ts
- pipeline-cli/src/next-step/next-step.test.ts
- pipeline-cli/src/next-step/resume-decision.ts
- pipeline-cli/src/next-step/resume-decision.test.ts
- pipeline-cli/src/next-step/head-envelope.ts

## Design decisions
Ran `pnpm build && pnpm test && pnpm lint && pnpm format:check` from the worktree root and it exited 0. I did not keep the test summary line. Push and PR creation were skipped, as instructed for this review iteration. The untracked files under `.ai-sdlc/reviews/` and `.ai-sdlc/transcript-leaves/` were left out of the commit.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

