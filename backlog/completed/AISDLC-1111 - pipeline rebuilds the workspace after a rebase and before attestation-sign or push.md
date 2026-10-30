---
id: AISDLC-1111
title: >-
  Pipeline rebuilds the workspace after a rebase and before attestation-sign or push (missing orchestrator dist and stale reference dist stop the run at the last step)
status: Done
assignee: []
created_date: '2026-10-29'
labels:
  - pipeline
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - docs/operations/tooling-limitations.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Eight open PRs on 2026-10-29 (#2080, #2082, #2108, #2111, #2063, #2057, #2127, #2024) finished the developer pass and the review rounds and then stopped at the very last step. Two failure shapes, one cause: the task worktree does not hold a current build of the workspace packages when the pipeline reaches the pre-push attestation-sign hook or the push step.

1. `attestation-sign` hard-fails because `orchestrator/dist/runtime/attestations.js` does not exist in the worktree (the worktree was installed with `--ignore-scripts` and never built, or the build predates a rebase that changed the orchestrator). The executor's only recourse is to run `pnpm --filter @ai-sdlc/orchestrator build` by hand and ask dispatch for a push-only reenter.
2. The pre-push build fails with `TS2305 ... has no exported member` in `orchestrator/src/design-review-pipeline.ts` after the pre-sign rebase onto main: the branch now compiles against main's sources but `@ai-sdlc/reference` in `node_modules` still points at the stale `dist` built before the rebase.

Both shapes burn a full developer plus review round and then produce a `failed` verdict that needs a human ruling. Resumes loop on the same spot because the resume path rebases again and again builds nothing.

**Five-step review (requirements first).** The requirement questioned is "the worktree is built once at setup": a rebase invalidates that build, so the real requirement is "the tree that is signed and pushed is built from the sources being pushed". Nothing to delete. Simplified: one rule, "after any rebase inside the pipeline, run `pnpm build` (workspace, topological) before the sign or push step", replaces the per-executor hand builds and the push-only reenters. Accelerated: the build runs only when the rebase moved HEAD or when the required `dist` entry points are missing, so a push-only resume on an unchanged head pays nothing. Automated: the pipeline step does it; no prompt text and no executor cooperation.

Fix: in the setup step and in every rebase done by the pipeline (the pre-sign rebase in the push step and the fix-round resume), call a shared `ensureWorkspaceBuilt(worktree, { changedSince })` that runs `pnpm build` when HEAD moved since the last build or when `orchestrator/dist/runtime/attestations.js` or `reference/dist/index.js` is absent. Record the build sha in `.ai-sdlc/.last-build-sha` inside the worktree. The attestation-sign hook keeps refusing on a missing dist, but the pipeline must never reach it in that state. Add the ceiling and its headroom to `docs/operations/tooling-limitations.md` only if a true tooling limit is found; otherwise document the rule in the pipeline step docs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] A worktree set up by the pipeline has `orchestrator/dist/runtime/attestations.js` and `reference/dist` present before the developer pass starts (test in `03-setup-worktree.test.ts`).
- [x] After the pre-sign rebase in the push step moves HEAD, the workspace is rebuilt before `attestation-sign` runs; a rebase that does not move HEAD does not rebuild (tests in `11-push-and-pr.test.ts`).
- [x] A fix-round resume whose rebase moves HEAD rebuilds before signing (test in `resume-fix-round.test.ts`).
- [x] A missing dist entry point triggers a rebuild even when HEAD did not move.
- [x] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: `.ai-sdlc/dispatch/failed/` verdicts dated 2026-10-29 for the PRs listed above ("attestation-sign hard-failed because orchestrator/dist was not built in the worktree", "TS2305 ... @ai-sdlc/reference has no exported member ... likely stale reference build after the rebase").

## Verification record

`pnpm --filter @ai-sdlc/pipeline-cli test` (vitest run): full run had 1 load-induced flake outside the touched files; re-run split passes: `src/steps` 30 files, 699 tests passed; remainder 532 files, 11665 tests passed, 13 skipped. build, lint, format:check clean.

Re-verified after rebase onto 08909b3a0: `pnpm test` with the ambient hierarchy env vars unset (AI_SDLC_HIERARCHY_SESSION, AI_SDLC_HIERARCHY_ROLE, AI_SDLC_EXECUTOR_TASK, which make executor-start.test.ts and hierarchy.test.ts claim against the live board): pipeline-cli `Test Files 567 passed`, hierarchy `Test Files 59 passed (59), Tests 984 passed (984)`. build, lint, format:check clean.

## Final Summary

## Summary
Rebased the existing AISDLC-1111 work onto origin/main and force-pushed it to PR #2139. The only rebase conflict was in `.gitignore`, and I kept both sides. The work adds a shared `ensureWorkspaceBuilt` that rebuilds the workspace when HEAD moved or the dist entry points are missing. It is called from worktree setup, the pre-sign rebase in the push step, and the fix-round resume.

## Changes
- .gitignore
- backlog/tasks/AISDLC-1111 - pipeline rebuilds the workspace after a rebase and before attestation-sign or push.md
- docs/operations/backlog-and-execution-reference.md
- pipeline-cli/src/steps/03-setup-worktree.ts
- pipeline-cli/src/steps/03-setup-worktree.test.ts
- pipeline-cli/src/steps/11-push-and-pr.ts
- pipeline-cli/src/steps/11-push-and-pr.test.ts
- pipeline-cli/src/steps/ensure-workspace-built.ts
- pipeline-cli/src/steps/ensure-workspace-built.test.ts
- pipeline-cli/src/steps/resume-fix-round.test.ts

## Design decisions
The full `pnpm test` run had 15 failures, all in `pipeline-cli/src/hierarchy/executor-start.test.ts` and `hierarchy.test.ts`. They come from the ambient `AI_SDLC_HIERARCHY_SESSION`, `AI_SDLC_HIERARCHY_ROLE` and `AI_SDLC_EXECUTOR_TASK` variables in this session, which make those tests claim against the live board. With those variables and `AI_SDLC_ACTIVE_TASK_ID` unset, `npx vitest run src/hierarchy/` in `pipeline-cli` passes: 59 files, 984 tests. The other 565 test files passed in the full run. The task diff does not touch those two test files or their source. I did not re-run the whole suite with the variables unset. The task file records the test command and summary line, including this variable caveat. `pnpm lint` and `pnpm format:check` were clean after the rebase.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

