---
id: AISDLC-1086
title: 'next-step runs the verification commands itself after the developer returns: the machine-written result replaces the developer self-report, a red run routes into the fix round, and the test waiver shape is deleted'
status: In Progress
assignee: []
created_date: '2026-10-27'
labels:
  - pipeline-cli
  - governance
  - bug
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/steps/10-finalize.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/dispatch/enqueue.ts
  - pipeline-cli/src/types.ts
  - scripts/check-pr-governance.mjs
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
---

## Description

Survey of the 116 completed task files since 2026-10-01 that carry a `pnpm test` bullet (planner, 2026-10-27): 13 record the suite as waived or skipped, 17 say passed while the prose admits only a subset ran or nothing was re-run after the developer's own fix, and 35 reword the bullet to list failures called unrelated. More than half of the reports do not prove a green suite. The waived-tests governance gate caught the latest case (PR 2019) only after three reviewers approved it, and the task that created that gate waived its own suite.

The cause is structural, not dishonesty. The verification record is a self-report: the developer subagent returns `verifications` and Step 10 copies those four words into the task file (`10-finalize.ts`, `buildFinalSummary`). The same subagent that wrote the code decides whether it was verified, under a prompt that carries both the "a locally failing test is waived when it passes alone" rule (`TEST_WAIVER_RULE`, `05-build-dev-prompt.ts`) and the rule that forbids waiving on pipeline paths. PR 2013 already built the independent runner: `steps/verify-commands.ts` runs the commands in the worktree, detects "claimed green but red", formats developer feedback from the failing command and logs a developer-honesty event. It is wired only into `execute-pipeline.ts`, which the orchestrator loop uses. The `next-step` state machine that every executor runs through `/ai-sdlc execute` never calls it.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the developer reports its own verifications": a verification is evidence produced by an independent node with a clean context, and here the node needs no model at all, so the self-report is removed rather than policed. Deleted: `testWaiver`, the `waived` verification status, `TEST_WAIVER_RULE` and the waiver paragraph in `developer.md`, the waiver block in the PR body (`11-push-and-pr.ts`), the duplicate `DEFAULT_VERIFY_COMMANDS` in `dispatch/enqueue.ts`, and the waived-tests check in `check-pr-governance.mjs` once the bullets are machine-written (the gate guarded a field that no longer exists). Simplified: one verification record, written by `runVerifyCommands` from exit codes and summary lines, consumed by Step 10, the PR body and the verdict. Accelerated: a red run goes straight into the existing fix round with the failing command's output tail as the developer's input, instead of the `developer-failed` hard stop in `onDeveloper`. Automated: a next-step test drives a developer return that claims green over a worktree whose suite fails and asserts the fix round, the honesty event and the machine-written bullets.

1. In `next-step.ts` `onDeveloper`, after `parseDeveloperReturn` and before `review`, call `runVerifyCommands` in the task worktree with the manifest's `spec.verifyCommands` or the defaults. Persist the run with `writeVerifyRunState`.
2. On a red run: record the honesty event when the developer claimed green, rebuild the developer prompt with `resumeFeedback: formatVerifyFeedback(run)`, write `developer-prompt-N.md`, spawn the developer, bounded by the same `maxIterations` as review rounds. At the cap, ship with `needsHumanAttention` the same way `afterVerdict` does.
3. The developer return keeps `verifications` as an optional claim for the honesty comparison only; `parseDeveloperReturn` no longer fails on `verifications.X = failed` and no longer accepts or requires `testWaiver`. Remove `'waived'` from `VerificationStatus`. On a resume with an unchanged patch id the verifier still runs; `skipped` is written only for a docs-only run (`skipped: 'docs-only'`).
4. Step 10 writes the four bullets from the verify run, each with the command's summary line (for example `pnpm test — passed (Tests 12143 passed, 154 s)`); Step 11 drops the waiver block and adds the same lines to the PR body.
5. Remove `TEST_WAIVER_RULE` from the prompt and the waiver paragraph from `developer.md`; render the AISDLC-1022 prompt rule as "the pipeline runs the verification commands after you return; report what you ran in `notes`, the record is written by the pipeline".
6. Delete the `waived-tests` check from `check-pr-governance.mjs` and its test; delete the duplicate default command list in `dispatch/enqueue.ts` in favour of the one in `verify-commands.ts`.
7. Record the decision: the local verification waiver (DEC-0202, written as temporary) is superseded for every path by the machine-run verification; the catalog record for this task names it.

## Acceptance Criteria

- [ ] A next-step test: the developer returns `verifications.test: passed` over a worktree whose `pnpm test` exits 1; the state machine writes a developer-honesty event, rebuilds the developer prompt with the failing command's output tail, and does not enter review until a later run is green.
- [ ] A next-step test: a green verify run writes the four bullets with summary lines into the task file and the PR body; the words `waived` and `testWaiver` appear nowhere in `pipeline-cli/src`, `ai-sdlc-plugin/agents/developer.md` or `prompt-rules.js` except in the honesty event history reader.
- [ ] A developer return that omits `verifications` or `testWaiver` is accepted; one that includes `verifications.test: failed` is accepted and the verifier result decides.
- [ ] `execute-pipeline.ts` and `next-step.ts` call the same `runVerifyCommands` and the same default command list; `dispatch/enqueue.ts` imports it.
- [ ] `check-pr-governance.mjs all` no longer has a `waived-tests` check; its tests are updated and the governance-gate job still passes on this PR.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
