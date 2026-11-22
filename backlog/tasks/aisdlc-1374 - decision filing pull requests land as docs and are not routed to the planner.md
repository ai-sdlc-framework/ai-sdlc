---
id: AISDLC-1374
title: 'Decision filing pull requests land as docs and are not routed to the planner'
status: In Progress
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - hierarchy
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/land-eligible.test.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reconcile.test.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/cli/file.ts
  - docs/operations/cli-hierarchy.md
priority: medium
---

## Description

**Gap.** The planner's decision filing PRs (`cli-decisions ... --file --pr`, branch `ai-sdlc/file-<dec>-<kind>-<hhmm>`) never land on their own. They are reported as "no-match" and routed to the planner. Through AISDLC-1373 that routing also types a notice into the planner pane. Reported on 2026-11-21 by the arcana-website-planner session (pipeline-cli 0.43.0). The operator asked for this task to be filed.

**Facts read in code** (main at 687e0d596, paths under `pipeline-cli/src/`).

- `hierarchy/land-eligible.ts:217-236`: `createLander` always uses `sourceKind: 'backlog'` (`:225`). It lands any non-draft PR by a `mergeAuthors` login (`:148-153`) and has no handling for `ai-sdlc/file-*` branches or `DEC-*` ids.
- `governance/merge-if-eligible.ts:624-639`: with `backlog`, `deriveTaskId` reads an `AISDLC-n` id from the branch, or a trailing `(ID)` from the title. It then requires that task file in the PR or on main (`:816-840`). A decision filing PR is titled `record DEC-x (<taskId>)` (`cli/file.ts:815-820`). It is refused when the trailing id is `planner` or names no task file.
- `hierarchy/reconcile.ts:59-71, :235-247`: the docs lane maps `no-match` to `arm`. Its arm command (`:503-521`) also uses `--source-kind backlog`. `taskIdFrom` (`:157`, `:171-175`) falls back to the first `[A-Z]+-\d+` in the title, so a decision PR gets `DEC-xxxx`. The backlog check then refuses it, and the PR is handed to the planner.
- `cli/file.ts`: `task --close` (`:702-705`) and `rebase` (`:959-975`) already arm through `armDocsPr`, which runs `cli-merge-if-eligible <n> --source-kind docs --arm` (`:979-985`). `fileTask` (`:577-625`) and `fileDecision` (`:708-843`) do not arm.
- `hierarchy/land-eligible.ts:100-105, :155`: when the repo has no auto-merge, the lander switches to an immediate squash once the PR is green and CLEAN. It does not skip.

**Observed** (from the peer report, not reproduced here). Decision filing PRs were routed as "no-match", and an "arm failed" notice was sent in a repo without auto-merge.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a filing PR made by `cli-file` or `cli-decisions` holds only backlog or decision records. It should land through the docs source kind, as `cli-file rebase` already does, not through the backlog task check. 2. Deleted: the planner route for a filing PR that the docs check accepts. 3. Simplified: one rule for picking the source kind, shared by `createLander` and the reconciler arm command. 4. Accelerated: decision records reach main without the planner. 5. Automated: tests over branch and title shapes.

- Pick the source kind from the PR: a branch matching `ai-sdlc/file-*`, whose diff contains only backlog or decision record files, uses `--source-kind docs`. Everything else keeps `backlog`. Use the same function in `land-eligible.ts` and in the reconciler's docs-lane arm (`reconcile.ts:503-521`).
- `taskIdFrom` must not turn a `DEC-xxxx` id into a backlog task id. A filing PR without a task id lands as docs; it is not handed to the planner.
- When the repo has no auto-merge, do not try to arm and do not report "arm failed". The lander's existing immediate-merge path handles it once the PR is green and CLEAN.
- Update `docs/operations/cli-hierarchy.md` where it describes how filing PRs land.

Out of scope: how notices reach the planner (AISDLC-1373); the docs source kind's own checks in `merge-if-eligible.ts`, which stay as they are.

## Acceptance Criteria

- [ ] #1 A test shows a decision filing PR (branch `ai-sdlc/file-dec-0422-opened-1200`, title `record DEC-0422 (planner)`) is landed with `--source-kind docs` by the lander and armed with `docs` by the reconciler, and is not routed to the planner.
- [ ] #2 A test shows a task filing PR (`ai-sdlc/file-aisdlc-1374`) still lands, and a task PR (`ai-sdlc/issue-...` or `feat/...`) still uses `backlog`.
- [ ] #3 A test shows a `file-*` branch whose diff touches a source file is not landed as docs.
- [ ] #4 A test shows that in a repo without auto-merge no arm command is run and no "arm failed" notice is produced.
- [ ] #5 `docs/operations/cli-hierarchy.md` states how filing PRs land.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
