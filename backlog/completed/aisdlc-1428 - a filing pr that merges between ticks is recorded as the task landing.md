---
id: AISDLC-1428
title: A filing commit or PR is treated as the task shipping or landing
status: Done
priority: high
labels:
  - dispatch
  - reconciler
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reconcile.test.ts
  - pipeline-cli/src/hierarchy/filing-branches.ts
  - pipeline-cli/src/dispatch/retire-landed.ts
  - pipeline-cli/src/dispatch/retire-failed-landed.test.ts
  - pipeline-cli/src/dor/dispatch-readiness.ts
  - pipeline-cli/src/dor/dispatch-readiness.test.ts
  - pipeline-cli/src/cli/file.ts
  - docs/operations/cli-hierarchy.md
---

## Description

**Five-step review (requirements first).**
1. Question: reported by the ai-sdlc-enterprise planner (earlier, and again on 2026-11-26 as O1): a filing commit `chore(docs): file backlog task ... (ENT-n)` marks the task landed. A filing PR must never land a task; landing means the task's code PR merged (CLAUDE.md "Done semantics"). This class was closed before: AISDLC-1177, 1235 (`ai-sdlc/update-` branch), 1297 (`isOwnCodePr`) and 1381 (completed-on-main check, shipped in 0.45.0), all Done. The AISDLC-1381 developer could not reproduce "a record with no kind and no branch". Two paths remain, both confirmed by reading:
   - **Path 1: dispatch-readiness (literal match, reproducible).** `dor/dispatch-readiness.ts:190-205` marks an open task `stale-shipped` when any `origin/main` commit subject contains `(<ID>)`, via `findShippedCommits` (`:427-438`). `cli-file` writes exactly `chore(docs): file backlog task <ID> (<ID>)` (`cli/file.ts:607`), so every filed task that is still open reads as shipped in `cli-deps frontier --check-dispatch-readiness`. This annotates and skips the task; it writes no landing.
   - **Path 2: reconciler (between ticks).** A filing PR that leaves the open list between two ticks is picked up by the "record not yet landed" loop (`reconcile.ts:1811-1836`). The fact it builds has `prNumber`, `taskId`, `merged`, `headSha`, `mergeSha` but no `headBranch` and no `title` (`:1829-1835`). `decide` calls `detectKind` with no branch (`:208-212`), so the docs-lane prefixes (`:169`) cannot match and the record's `taskId` (taken from the title while the PR was open, `taskIdFrom` title fallback `:174-178`) makes the kind `task` (`:170`). The rewritten record takes `kind: d.kind` and keeps `headBranch` only from the fact (`:1369-1373`), so the earlier branch is lost. The retire calls then get kind `task` and no branch (`:1424-1442`); `isOwnCodePr` accepts that when the verdict has no `prNumber` (`retire-landed.ts:48-53`), and `retireBlockedManifest` never passes one. The AISDLC-1381 completed-on-main check exists only in `retireFailedLanded` (`:243-246`; `completedTaskIdsOnMain` at `:290`). A filing PR auto-merges quickly, so merging between ticks is the common case. A filing from a non-prefix head branch (a hand-made or adopter-tool branch) reaches `task` by the same title fallback; the exact adopter branch is not known.
2. Delete: on the retire paths, the fail-open acceptance of a `task` record whose head branch is unknown.
3. Simplify: (i) `findShippedCommits` ignores subjects that match the `cli-file` file and update subjects, built from one exported definition shared with `cli/file.ts:607` so they cannot drift. (ii) The between-ticks fact carries the record's `headBranch` (and `kind`), and when the fact has none the landing record keeps the `kind` and `headBranch` it already had. (iii) Apply the AISDLC-1381 rule to the other retire paths: `retireFailedVerdict`, `retireBlockedManifest` and the sweep refuse when main is readable and the task file is not under `backlog/completed/`. Path 1 is fixed regardless of the landing record. Planner decision: the reconciler change (Path 2) is gated on the reporter's landing record: AC #1 requires the record before any reconciler change, and if the record shows another shape, that shape is named in the PR body and fixed instead.
4. Accelerate: none.
5. Automate: regression tests (AC #2 to #4).

**First step for the developer.** Ask the reporter for the landing record JSON of the filing PR (`.ai-sdlc/dispatch/landing/<pr>.json`) and the matching `board-events.jsonl` or unland-log line. Path 2 predicts `kind: "task"`, `action: "mark-landed"`, no `headBranch`, and earlier history entries that are docs-lane.

## Acceptance Criteria
- [ ] #1 Before any change to `reconcile.ts` or the retire paths, the PR body records the reporter's landing record (or states it was unavailable) and names which path matched. Without the record, only Path 1 is changed.
- [ ] #2 A dispatch-readiness test: the subjects `chore(docs): file backlog task ENT-12 (ENT-12)` and the `update` form do not make ENT-12 `stale-shipped`, while `feat(x): thing (ENT-12)` still does. The filing subject and the pattern come from one exported definition.
- [ ] #3 A reconciler test (needs AC #1): a landing record for an open filing PR (`headBranch: 'ai-sdlc/file-ent-12'`, kind `docs`) goes through a tick where the PR is no longer open and `gh pr view` reports `MERGED`. The rewritten record keeps kind `docs` and its `headBranch`, and no failed verdict or blocked manifest for ENT-12 moves. It fails on main.
- [ ] #4 Tests: `retireFailedVerdict`, `retireBlockedManifest` and `retireLandedSweep` each refuse a task whose file is not under `backlog/completed/` on a readable main, even given a `kind: 'task'` record with no head branch. Existing retire tests pass or change only where they relied on main being unreadable; the PR body lists each.
- [ ] #5 `docs/operations/cli-hierarchy.md` states in one sentence that a task is retired as landed only when its file is in `backlog/completed/` on main.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
