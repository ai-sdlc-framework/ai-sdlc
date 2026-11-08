---
id: AISDLC-1248
title: 'cli-dispatch write-manifest --from-pr and classifyPr refuse a filing branch, so a stale reconciler can never rewrite a task manifest to ai-sdlc/update-* or ai-sdlc/file-*'
status: Done
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - reconciler
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/filing-branches.ts
  - pipeline-cli/src/dispatch/board.ts
priority: medium
dispatchable: true
dispatchableReason: 'Planner wake 2026-11-08 18:0xZ (DEC-0401 keep-and-automate): on 2026-11-08 the reconciler rewrote the queued manifests of AISDLC-506 (17:06:48Z, from #2575) and AISDLC-521 (17:21:57Z, from #2579) to the filing branch ai-sdlc/update-<id>; both executors then opened PRs on the computed branch and the landing records show manifest-branch-mismatch. The AISDLC-1235 docs-kind early return in decide() exists in source but the running process had not loaded it; the write path itself has no guard.'
---

## Description

**Gap.** `taskIdFrom(headRefName, title)` (`reconcile.ts` 171) reads the task id from the PR title when the branch carries none, so a filing PR `ai-sdlc/update-aisdlc-521` titled `chore(docs): update backlog task AISDLC-521` resolves to the task's queued manifest. `classifyPr` (`pr-state.ts` 186) compares that manifest's branch with the PR head and returns `manifest-branch-mismatch` without checking the PR's kind; `decide` picks `rewrite-manifest` for a queued manifest (`reconcile.ts` 250-251) and runs `cli-dispatch write-manifest --from-pr <n>` (`reconcile.ts` 491, `cli/dispatch.ts` 1286-1300, `board.ts` 181). AISDLC-1235 added a `detectKind` early return in `decide`, but that is one call site; the state classifier and the write command still accept a filing branch. On 2026-11-08 a process running the pre-1235 build rewrote two manifests (see `.ai-sdlc/dispatch/log/reconcile.log` 232232 and 232616).

**Shape.** Defence at the two places that matter: `classifyPr` never returns `manifest-branch-mismatch` for a head branch matching `DOCS_BRANCH_PREFIXES` (`filing-branches.ts`), and `write-manifest --from-pr` exits non-zero with `refused: <branch> is a filing branch` for the same prefixes. One shared predicate from `filing-branches.ts`.

## Fix

**Five-step review (requirements first).**
1. Question: is a guard in `decide` enough? No; the write command is reachable from a stale build and from an operator, and the classifier feeds every caller.
2. Delete: nothing.
3. Simplify: one `isFilingBranch(name)` predicate reused in three places.
4. Accelerate: none.
5. Automate: tests for the classifier and the command refusal.

## Acceptance Criteria

- [x] AC-1: `classifyPr` with a manifest branch `ai-sdlc/aisdlc-521-...` and a PR head `ai-sdlc/update-aisdlc-521` returns the docs classification, not `manifest-branch-mismatch`; test.
- [x] AC-2: `cli-dispatch write-manifest <task> --from-pr <n>` refuses when the PR head matches a filing prefix, exit code non-zero, manifest unchanged; test with a stubbed PR view.
- [x] AC-3: `write-manifest <task> --branch <head>` refuses the same prefixes; test.
- [x] AC-4: `docs/operations/cli-hierarchy.md` `manifest-branch-mismatch` row names the guard in one sentence.
- [x] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
classifyPr no longer returns manifest-branch-mismatch for a filing head, and write-manifest refuses a filing branch through both --from-pr and --branch. Both use one shared isFilingBranch predicate in filing-branches.ts. A draft PR is open.

## Changes
- pipeline-cli/src/hierarchy/filing-branches.ts
- pipeline-cli/src/hierarchy/reconcile.ts
- pipeline-cli/src/hierarchy/pr-state.ts
- pipeline-cli/src/hierarchy/pr-state.test.ts
- pipeline-cli/src/cli/dispatch.ts
- pipeline-cli/src/cli/dispatch.test.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1248 - write-manifest from-pr refuses a filing branch.md

## Design decisions
DOCS_BRANCH_PREFIXES moved into filing-branches.ts and is re-exported from reconcile.ts, so existing importers are unchanged. I added an optional prHeadBranch dep to runDispatchCli so tests can stub the PR view. For AC-1, a filing head now skips the mismatch check and falls through to the normal classification, because pr-state.ts has no separate docs state. The refusal message is `refused: <branch> is a filing branch`, with exit code 1. The backlog task file's status change to In Progress is included in the commit.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

