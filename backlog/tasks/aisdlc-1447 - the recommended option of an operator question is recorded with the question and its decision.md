---
id: AISDLC-1447
title: "The recommended option of an operator question is recorded with the question and its decision"
status: To Do
priority: medium
labels:
  - judgment
  - decisions
  - rfc-0049
dependencies:
  - AISDLC-1443
assumes: [RFC-0049]
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/decisions/decision-record.ts
  - pipeline-cli/src/cli
---

## Description

RFC-0049 OQ-8 (DEC-0436, provisional until Product signs the amendment) promotes `operator-question.auto-answer` only if it is at least 80% correct on at least 20 questions where the operator did not pick the recommended option. Today nothing records which option was recommended: `cli-decisions add` has no field for it, and the AISDLC-1443 question-gate log keeps only the options. Without it the deviation set is empty and the judgment can never be promoted.

## Acceptance Criteria
- [ ] #1 `cli-decisions add --recommended <option-id>` stores `recommendedOptionId` on the `decision-opened` event; an id that is not one of the declared options is refused; omitting it stores nothing (older events stay valid). `cli-decisions show` and `operator-digest` print it.
- [ ] #2 The AISDLC-1443 gate log records `recommendedOptionId` for each question: the option whose label ends in `(Recommended)`, or none when no label does or more than one does. Tested for each case.
- [ ] #3 The `decision-rubric` skill tells the session to pass `--recommended` when it files the decision record for a question it framed.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
