---
id: AISDLC-1149
title: 'Task PRs open ready when CodeQL does not run on pull requests: shared detection for step 11, ship and mark-ready, openTaskPrsReady in the schema'
status: To Do
assignee: []
created_date: '2026-11-01'
labels:
  - pipeline
  - dispatch
  - governance
  - incident
dependencies: []
references:
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/hierarchy/mark-ready.ts
  - pipeline-cli/src/hierarchy/operational.ts
  - spec/schemas/agent-role.schema.json
  - sdk-go/core/schemas/agent-role.schema.json
  - .ai-sdlc/agent-role.yaml
  - docs/operations/cli-hierarchy.md
  - docs/api-reference/governance.md
priority: high
dispatchable: true
---

## Description

On 2026-11-01 eleven task PRs (#2251 to #2261) sat as drafts for up to 1h40m with no CI run. Draft PRs skip every gate job (AISDLC-218), so `ai-sdlc/pr-ready` never posted and the reconciler routed each PR to the planner as unowned. The operator flipped ten by hand with `gh pr ready`.

Root cause, in three parts:

1. Step 11 (`11-push-and-pr.ts`, the `--draft` flag) and `ship.ts` open task PRs as drafts unless `governance.openTaskPrsReady` is true. The ready flip is delegated to `markReadyAfterCodeql` on the dispatch tick (DEC-0062, AISDLC-736).
2. `repoHasCodeql` in `mark-ready.ts` returns true when any workflow file references `github/codeql-action`. This repository keeps `codeql.yml` on a schedule only; DEC-0250 (AISDLC-934) removed its `pull_request` trigger. A task PR therefore never carries an `Analyze` check, `analyzeState` stays `pending`, and no draft can ever flip. The no-CodeQL branch added by AISDLC-896 (flip `ai-sdlc/*` heads on the repo check rollup) is unreachable here.
3. The `openTaskPrsReady` opt-out (AISDLC-896) is parsed by `operational.ts` but is absent from `spec/schemas/agent-role.schema.json` and its Go mirror, is documented only in `docs/operations/cli-hierarchy.md`, and is unset in this repository. AISDLC-896 is in `backlog/completed/` with every acceptance criterion unchecked.

The body phrase `draft until CodeQL is clean` that `mark-ready.ts` matches was never emitted by any PR body template; it only ever appeared in hand-written security task specs. Emitting it would change nothing, because the Analyze checks still would not exist.

**Five-step review (requirements first).**
1. Requirement questioned: does a task PR need to open as a draft at all? AISDLC-218 introduced the draft to avoid a second CI run while the developer and reviewers iterated. Step 11 now creates the PR after review and signing, so CI runs once either way. The only remaining reason is a repository whose CodeQL analysis runs on pull requests and must be clean before a reviewer sees the PR (DEC-0062). The requirement is therefore conditional: draft only where CodeQL runs on pull requests.
2. Delete: the body-phrase regex in `mark-ready.ts`. With CodeQL running on pull requests the head-branch rule (`ai-sdlc/*`) already identifies task PRs; the phrase never had a producer.
3. Simplify: one exported helper, `codeqlRunsOnPullRequests(repoRoot)`, replaces `repoHasCodeql`: true only when a workflow both references `github/codeql-action` and has a `pull_request` or `pull_request_target` trigger. Step 11, ship and mark-ready all read it, so the default is right without configuration.
4. Accelerate: step 11 and ship open the PR ready directly when the helper is false; CI starts on create instead of waiting for a dispatch tick that reads GitHub.
5. Automate: the gate is `pnpm test`; a unit test per consumer and a schema test for `openTaskPrsReady`.

Velocity impact: positive. Task PRs reach `ai-sdlc/pr-ready` on open; no planner routing for a PR that is only waiting on a flip.

## Acceptance Criteria

- [ ] AC-1: `pipeline-cli/src/hierarchy/mark-ready.ts` exports `codeqlRunsOnPullRequests(repoRoot)`: true only when a workflow under `.github/workflows/` references `github/codeql-action` and declares a `pull_request` or `pull_request_target` trigger. `repoHasCodeql` is removed or re-pointed to it. Tests cover: no CodeQL workflow; CodeQL on schedule only (this repository's shape); CodeQL on `pull_request`; the `upload-sarif`-only case (scorecard) counts as no CodeQL.
- [ ] AC-2: Step 11 (`11-push-and-pr.ts`) and `ship.ts` pass `--draft` only when `codeqlRunsOnPullRequests` is true and `openTaskPrsReady` is false. The pipeline log line names the reason (`draft: codeql runs on pull requests` or `ready: no pull-request codeql` or `ready: governance.openTaskPrsReady`). Tests for all three.
- [ ] AC-3: `markReadyAfterCodeql` drops the body-phrase match; in the CodeQL case it selects drafts by head branch `^ai-sdlc/` exactly as the no-CodeQL case does. Existing tests updated; the `superseded by` and `DIRTY` skips unchanged.
- [ ] AC-4: `governance.openTaskPrsReady` (boolean, default false) is added to `spec/schemas/agent-role.schema.json` `$defs/Governance` and `sdk-go/core/schemas/agent-role.schema.json`, with a schema test, and documented in `docs/api-reference/governance.md` next to the other governance keys. The `docs/operations/cli-hierarchy.md` paragraph is updated to describe the new default.
- [ ] AC-5: `.ai-sdlc/agent-role.yaml` in this repository sets `governance.openTaskPrsReady: true` with a comment citing this task and DEC-0290, so the behaviour holds even before AC-2 is read from the verified main checkout.
- [ ] AC-6: `backlog/completed/` entry for AISDLC-896: a Notes line records that its acceptance criteria were delivered in code but never ticked, and that the schema and docs gap is closed by this task. No other edit to that file.

## Notes

Origin: operator report 2026-11-01 ~20:45Z, PRs #2251 to #2261 draft with CI skipped. Decision DEC-0290 (planner, class a, operator delegated the choice) records the option taken: fix detection and open ready by default, keep `openTaskPrsReady` as an explicit override; rejected: emitting the body phrase (no effect without Analyze checks) and config-only (leaves every adopter without CodeQL-on-PR stuck). Related, not in scope: the TICK escalation record carries an empty message (`dispatch.ts` runCli has no timeout and captures no exit code), and a failed verdict without `signedAt` makes the reconciler route the PR as unowned rather than reclaimable (AISDLC-1139); both reported to the planner separately.
