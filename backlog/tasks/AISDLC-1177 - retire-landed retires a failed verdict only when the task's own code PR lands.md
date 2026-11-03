---
id: AISDLC-1177
title: 'retire-landed moves a failed verdict to done when the task''s docs filing PR lands, though its code PR is still open'
status: To Do
assignee: []
created_date: '2026-11-03'
labels:
  - dispatch
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/dispatch/retire-landed.ts
  - pipeline-cli/src/dispatch/retire-landed.test.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
priority: high
dispatchable: true
---

## Description

**Five-step review (requirements first).**
1. Question the requirement: AISDLC-1158 says landing is the only trigger for done. The requirement is that the task's own code PR landed. A merged PR that only names the task id, such as the `chore(docs): file backlog task AISDLC-N` filing PR, is not that event.
2. Delete: remove retirement from any landed PR that is not the task's code PR. Nothing else is deleted.
3. Simplify: put one guard in `retireFailedVerdict`, so the reconcile mark-landed path and the `cli-dispatch retire-landed` sweep both get it.
4. Accelerate: no change.
5. Automate: unit tests for the guard on both call paths.

**Observed 2026-11-03 ~21:45Z.** Dispatch ran `cli-dispatch retire-landed` to retire AISDLC-1164, whose code PR #2314 had merged. The sweep has no per-task filter. It moved 24 failed verdicts to `done/` with `outcome: success`. Twenty were right: each has a merged code PR. Four were wrong, each matched to its merged filing PR while its code PR was still open:

| task | matched (filing PR, merged) | code PR (open) | failed verdict's prNumber |
|---|---|---|---|
| AISDLC-1156 | #2288 | #2308 | 2308 |
| AISDLC-1163 | #2299 | #2307 | 2307 |
| AISDLC-1167 | #2317 | #2321 | none |
| AISDLC-1175 | #2330 | #2331 | none |

Cause, traced by the planner:
- `taskIdFrom` (`reconcile.ts`) misses the branch `ai-sdlc/file-aisdlc-N`, because the regex needs `letters-digits` after `ai-sdlc/`. It falls back to the id in the title, so the filing PR's landing record gets `taskId`. The landing record `landing/2317.json` even carries `kind: "task"`.
- `retireFailedVerdict` (`retire-landed.ts`) checks only that a failed verdict exists, that no done verdict exists, and that the outcome is not success. It ignores the PR kind and the verdict's own `prNumber`. So 1156 and 1163 were retired by #2288 and #2299 although their verdicts named #2308 and #2307.

**Fix.**
- `retireFailedVerdict` refuses to retire when the failed verdict records a `prNumber` and the landed PR's number differs.
- When the verdict records no `prNumber`, it refuses when the landed PR is a docs or filing PR: a head branch starting with one of `DOCS_BRANCH_PREFIXES`, or a landing record whose kind is not `task`. The sweep passes whatever the landing record holds for that check. Add the head branch to the landing record if it is not there today.
- A filing-PR landing record (`ai-sdlc/file-` head branch) gets kind `docs`, never `task`.

**Out of scope:**
- Repairing the four wrong `done/` verdicts by hand. Dispatch is re-entering all four with developer rounds, and re-entry supersedes the done record.
- A per-task filter for `retire-landed`.

## Acceptance Criteria

- [ ] AC-1: A landed PR whose number differs from the failed verdict's `prNumber` leaves the verdict in `failed/`, on both the reconcile mark-landed path and the sweep.
- [ ] AC-2: With no `prNumber` on the failed verdict, a landed filing PR (head branch `ai-sdlc/file-aisdlc-N`, title `chore(docs): file backlog task AISDLC-N (AISDLC-N)`) leaves the verdict in `failed/`.
- [ ] AC-3: A landed code PR whose number equals the verdict's `prNumber`, or a task-kind PR when the verdict has none, still retires the verdict exactly as before. The existing tests in `retire-landed.test.ts` pass unchanged.
- [ ] AC-4: A filing PR's landing record is written with kind `docs`.
- [ ] AC-5: Tests cover AC-1 to AC-4, with the 1167 shape (filing #2317 merged, code #2321 open, no verdict `prNumber`) and the 1156 shape (verdict `prNumber` 2308, filing #2288 merged) as fixtures.
