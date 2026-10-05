---
id: AISDLC-725
title: >-
  Incremental review works in every case: after a rejection, on every review path, with prior findings
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - review
  - cost
  - bug
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/orchestrator/reconcile.ts
  - pipeline-cli/src/pipeline/reviewer-runner.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-142 added an incremental review gate (execute command, Step 7a-bis) so a later review covers only the change since the last review. In practice it does not fire. Findings of 2026-10-04 on origin/main:

1. The reviewed-commit marker is written only after an APPROVED review ("the marker only ever binds to APPROVED states") and only as a pull request comment, so a round that follows a changes-requested verdict has no marker and gets a full review. The iterate step says to re-run the reviews against the updated diff.
2. Only `ai-sdlc-plugin/commands/execute.md` implements the gate. `ai-sdlc-plugin/commands/orchestrator-tick.md`, `ai-sdlc-plugin/commands/executor.md`, `pipeline-cli/src/orchestrator/reconcile.ts`, `pipeline-cli/src/pipeline/reviewer-runner.ts`, and the step 7 and step 9 code under `pipeline-cli/src/steps/` always embed the full diff.
3. None of seven recent pull requests carries the marker, and no gate decision appears in four days of session logs.
4. A later-round reviewer is not given the earlier findings; they go to the developer only.
5. Even a delta round's prompt says the verdict applies to the whole pull request, and a sampled reviewer re-read the full diff five times.
6. Defect: when the delta diff cannot be computed, the gate reads an empty numstat as zero lines, chooses delta-only and passes the full diff as the delta.

Cost evidence: a second-round reviewer run averages about the same tokens as a first-round run; 14 of 38 measured pull requests took three or more rounds.

The operator's ruling (DEC-0056, row 9): this is a defect in the feature; all of the causes are to be fixed so the delta review works as intended. The interim rule of two rounds then a planner ruling stays until delta rounds are real.

## Conventions
- Touches review and attestation code; the security review runs on opus for the attestation part only.
- Hermetic `node --test` or vitest tests; temporary directories come from `mkdtemp`.

## Acceptance Criteria
- [ ] The reviewed state is recorded after EVERY review round, whatever the verdict, and stored locally in the task worktree (with the pull request comment kept as a mirror when a PR exists), so it works before a pull request exists and across context clears.
- [ ] One shared implementation of the incremental decision is used by every review path: the execute command, the orchestrator tick reconcile fan-out, the executor loop, the headless reviewer runner and the step 7 / step 9 prompt builders. A test fails if a path builds a later-round prompt without going through it.
- [ ] A later-round reviewer receives: the diff since the commit it last reviewed; its own findings from the previous round with the developer's response to each; and an instruction to verify those fixes and review only the delta, opening surrounding files when the delta depends on them. The verdict wording no longer asks it to re-judge the whole pull request.
- [ ] Safety rules that force a full review are explicit and tested: delta above the line threshold (default 200), a new top-level directory, the last-reviewed commit no longer reachable after a rebase (compare by content, not by ancestry, where possible), a marker that fails validation, or a delta diff that cannot be computed. A failed or empty diff computation is never treated as a zero-line delta.
- [ ] The attestation and the review ledger record, per round, whether it was a full or delta review and the base commit, so the verifier and an auditor can see it; a delta round's leaf binds to the commit range it covered.
- [ ] Measurement: the pipeline logs one line per review round (full or delta, reason, delta size), and a report (in `cli-status` or the usage tooling) shows the share of second and later rounds that ran as delta reviews and the average tokens per round by round number. The task's PR body includes that report for at least ten real rounds after the change.
- [ ] Tests cover: round two after changes-requested is a delta round; each review path; prior findings present in the prompt; each forced-full condition; the empty-diff defect.
- [ ] PR body carries a "Velocity impact" section.

## Out of scope
- Changing the number of allowed rounds.
- Staged review planning.
<!-- SECTION:DESCRIPTION:END -->
