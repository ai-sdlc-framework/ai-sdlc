---
id: AISDLC-653
title: >-
  RFC-0050 Part B: join usage to outcomes and report quality and cost per role, model and task class
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
  - cli
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/src/attestation/reviews-analysis.ts
  - pipeline-cli/src/cli/reviews.ts
  - pipeline-cli/src/estimation/types.ts
  - pipeline-cli/src/orchestrator/events.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Quality is recorded (the reviews ledger holds each reviewer's verdict per iteration)
and cost is now recorded (the usage ledger), but nothing joins them. This task produces
the scorecard that every routing decision cites. RFC-0050 section B1.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Task outcome** derived per task from the reviews ledger
   (`pipeline-cli/src/attestation/reviews-ledger.ts`): `firstPassApproved` is true when
   every reviewer role recorded at iteration 1 approved with no critical or major
   finding; `iterations` is the highest iteration recorded; `blockingFindings` is the
   count of critical and major findings at iteration 1. Developer contract retries
   come from orchestrator events where present.
2. **Task class** is the estimation class for the task (`TaskClass` in
   `pipeline-cli/src/estimation/types.ts`), read from the task's recorded estimate or
   frontmatter, `uncategorized` when absent. T-shirt size is carried on each row.
3. **Model per task and role:** from the assignment log when AISDLC-654 has written
   one for that task and role, otherwise the model with the most usage-ledger calls for
   that task and role. Each row records which source was used and whether the arm was
   `explore`.
4. **`cli-usage scorecard`** with `--role`, `--since`, `--format`. One row per role,
   model and task class: number of tasks, first-pass approval rate, mean iterations,
   mean blocking findings, mean units per task, and the count of explored tasks. A row
   with fewer than 30 tasks is labelled `insufficient`. The threshold is read from
   config with 30 as the default.
5. **Conductor rows:** for the `main-session` role, units per reconciled task in place
   of approval rate.
6. **Evidence files:** `--write-evidence <dir>` writes one JSON file per cell with the
   rows, counts, date range and the ids of the tasks included, suitable for committing
   as the evidence a table change cites. It contains framework-scope data for the
   current repository only.

## Acceptance Criteria
- [ ] From a synthetic reviews ledger and usage ledger, a task approved by all reviewers at iteration 1 with only minor findings is `firstPassApproved`, and one with a major finding at iteration 1 is not.
- [ ] The scorecard row for a role, model and class reports the hand-computed approval rate, mean iterations and mean units for a fixture of known tasks.
- [ ] A cell with 29 tasks is labelled `insufficient` and one with 30 is not.
- [ ] A task with an assignment-log entry uses that model; a task without one uses the majority model from the usage ledger, and the row says which.
- [ ] Explored tasks are counted separately in each row.
- [ ] `--write-evidence` writes one file per cell listing the included task ids and contains no `other`-scope data.
- [ ] A task present in the usage ledger with no reviews-ledger rows is excluded from approval rates and counted in a reported `no-outcome` total.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
