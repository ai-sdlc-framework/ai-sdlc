---
id: AISDLC-1153
title: 'Verify gate strips the hierarchy session env before pnpm test, and the vitest setup clears the same vars: executor sessions stop failing 36 pipeline-cli tests with not-task-worktree'
status: In Progress
assignee: []
created_date: '2026-11-01'
labels:
  - hierarchy
  - verify
  - incident
dependencies: []
references:
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/steps/verify-defaults.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/runtime/exec.ts
  - pipeline-cli/src/hierarchy/lease-preflight.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - vitest.git-env.setup.mjs
  - scripts/check-git-env-hygiene.mjs
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Description

On 2026-11-01 seven executor runs (AISDLC-781, 1083, 1087, 1108, 1131, 1149, 1150) ended `developer-failed` with the same symptom: the pipeline's verify gate (`06-verify`, `pnpm test`) goes red on about 36 pipeline-cli vitest tests (`execute-pipeline*`, `steps/11-late-rebase`, `fixes-pr*`, `resume-fix-round`, the Step 11 push tests) with the lease-push preflight refusal `not-task-worktree`. The same failures reproduce on clean main 4f473980 whenever the executor session's env is present, and the whole suite passes with it unset. Seven PRs (#2271 to #2277) are therefore stuck as unreviewed, unsigned drafts, including the arming fix of AISDLC-1149.

Cause, by code reading: `runVerifyCommands` (`pipeline-cli/src/steps/verify-commands.ts`, around line 104) runs each command through `runCommand` with no `env` option, and `runtime/exec.ts` spreads `process.env` in, so `pnpm test` inherits `AI_SDLC_HIERARCHY_SESSION`, `AI_SDLC_HIERARCHY_ROLE`, `AI_SDLC_EXECUTOR_TASK`, `CLAUDE_PROJECT_DIR` and `AI_SDLC_GH_CALL_LOG` from the executor shell (`buildClaudeCommand`, `hierarchy/up.ts`). Step 11 (`11-push-and-pr.ts`, lines 483-497) passes no `env` to `leasePushPreflight`, which reads `process.env` through `trusted-policy.js` `evaluateLeasePush`; with `AI_SDLC_HIERARCHY_ROLE=executor` and a `CLAUDE_PROJECT_DIR` that is not the test's temp repo, the refusal blocks instead of warning. `vitest.git-env.setup.mjs` (AISDLC-1126) deletes only the `GIT_*` location vars, and the AISDLC-1127 hygiene gate (#2254) scans only for git spawns, so neither covers this. The AISDLC-1149 branch (a47c69f4) adds a setup hunk that clears three of the five vars; it is on an unlanded draft.

**Five-step review (requirements first).**
1. Requirement questioned: should any test ever observe the session that runs it? No. A test that behaves differently under an executor than under an operator is not a test of the code. The requirement is hermetic tests, not a different executor env.
2. Delete: nothing to delete. The lease preflight's env reading is correct for real runs.
3. Simplify: strip the hierarchy session vars once, in the verify runner, so every verify command (build, test, lint, format) sees the same env an operator shell would; and clear the same list in the vitest setup so a developer running vitest by hand inside an executor pane gets the same result. One exported list of var names, used by both.
4. Accelerate: nothing extra; the stripped run is the same length.
5. Automate: a test on `runVerifyCommands` asserting the spawned env lacks every name in the list even when `process.env` has them; the git-env-hygiene scan (`scripts/check-git-env-hygiene.mjs`) learns the same list so a new test that reads one of these vars without `makeGitEnv()` or an explicit `env` is flagged.

Velocity impact: unblocks seven stranded tasks and every future executor run; removes a failure class that costs two fix rounds per task.

## Acceptance Criteria

- [ ] AC-1: One exported constant (for example `HIERARCHY_SESSION_ENV_VARS` in `pipeline-cli/src/hierarchy/`) lists `AI_SDLC_HIERARCHY_SESSION`, `AI_SDLC_HIERARCHY_ROLE`, `AI_SDLC_EXECUTOR_TASK`, `CLAUDE_PROJECT_DIR`, `AI_SDLC_GH_CALL_LOG` and `AI_SDLC_WORKFLOW_STATE` (set by `execute-host.ts`, read by `verifyV6Envelope`); `runVerifyCommands` passes an `env` built from `process.env` minus those names to every verify command. A test proves the spawned env lacks each name when the parent has them set.
- [ ] AC-2: `vitest.git-env.setup.mjs` deletes the same five names (the list imported or mirrored with a test that fails when the two drift), superseding the three-name hunk on the AISDLC-1149 branch; that branch drops its hunk on rebase.
- [ ] AC-3: `pnpm test` passes on main from a shell that exports all five vars (the executor shape); the PR body shows the command and result.
- [ ] AC-4: `scripts/check-git-env-hygiene.mjs` flags a test that reads any of the five names from `process.env` without injecting `env`, with the baseline file unchanged (zero offenders after this change) or updated with the reason per entry.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` gains a paragraph under the executor section naming the stripped vars and why; the seven affected tasks are re-entered by dispatch after this lands (recorded in the brief, not in this task).

## Notes

Origin: planner triage 2026-11-01 ~23:20Z of the seven `developer-failed` verdicts on the board (`.ai-sdlc/dispatch/failed/AISDLC-*.verdict.json`), operator report "a whole bunch of PRs open in draft mode". The `webhook-receiver coalesce` load flake noted on AISDLC-1087 is separate and is not in scope. Related: AISDLC-1087 (verify board lock and vitest worker cap) is one of the stranded tasks and lands after this.
