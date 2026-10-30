---
id: AISDLC-1111
title: >-
  Pipeline rebuilds the workspace after a rebase and before attestation-sign or push (missing orchestrator dist and stale reference dist stop the run at the last step)
status: To Do
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

- [ ] A worktree set up by the pipeline has `orchestrator/dist/runtime/attestations.js` and `reference/dist` present before the developer pass starts (test in `03-setup-worktree.test.ts`).
- [ ] After the pre-sign rebase in the push step moves HEAD, the workspace is rebuilt before `attestation-sign` runs; a rebase that does not move HEAD does not rebuild (tests in `11-push-and-pr.test.ts`).
- [ ] A fix-round resume whose rebase moves HEAD rebuilds before signing (test in `resume-fix-round.test.ts`).
- [ ] A missing dist entry point triggers a rebuild even when HEAD did not move.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: `.ai-sdlc/dispatch/failed/` verdicts dated 2026-10-29 for the PRs listed above ("attestation-sign hard-failed because orchestrator/dist was not built in the worktree", "TS2305 ... @ai-sdlc/reference has no exported member ... likely stale reference build after the rebase").

## Verification record

`pnpm --filter @ai-sdlc/pipeline-cli test` (vitest run): full run had 1 load-induced flake outside the touched files; re-run split passes: `src/steps` 30 files, 699 tests passed; remainder 532 files, 11665 tests passed, 13 skipped. build, lint, format:check clean.

Re-verified after rebase onto 08909b3a0: `pnpm test` with the ambient hierarchy env vars unset (AI_SDLC_HIERARCHY_SESSION, AI_SDLC_HIERARCHY_ROLE, AI_SDLC_EXECUTOR_TASK, which make executor-start.test.ts and hierarchy.test.ts claim against the live board): pipeline-cli `Test Files 567 passed`, hierarchy `Test Files 59 passed (59), Tests 984 passed (984)`. build, lint, format:check clean.
