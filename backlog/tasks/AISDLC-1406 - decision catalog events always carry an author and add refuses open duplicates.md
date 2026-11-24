---
id: AISDLC-1406
title: 'Decision catalog events always carry an author, and add refuses open duplicates'
status: To Do
assignee: []
created_date: '2026-11-24'
labels:
  - decision-catalog
  - pipeline-cli
dependencies:
  - AISDLC-1405
references:
  - pipeline-cli/src/cli/decisions.ts
  - .ai-sdlc/_decisions/events
priority: medium
---

## Description

**Five-step review (requirements first).** The operator digest and later amendments need to know who decided (AISDLC-703 digest; the decision-rubric `Check:` line from AISDLC-1404). That requirement holds. Do not rewrite past events: the log is append-only. Fix the writers, and close the existing duplicates with supersede events.

**Gap (counted 2026-11-24 over `.ai-sdlc/_decisions/events/`):**
- 30 `decision-opened` and 72 `operator-answered` events have no `by`. The newest are from 2026-11-22, so a live writer still omits it. The digest prints these as author "unknown" (DEC-0424, DEC-0425).
- 5 pairs of open-time duplicates with identical summaries: DEC-0221/0222, DEC-0249/0250, DEC-0295/0406, DEC-0296/0297, DEC-0391/0402 (plus DEC-0091/0092, handled in AISDLC-1405).

## Fix

- Find every writer of `decision-opened` and `operator-answered` (`add`, `answer`, `escalate`, Stage C, `stuck-pr-decision`, the hierarchy hooks). Each stamps `by` (planner, operator, framework, executor:<name>, or the role from the session environment). Writing an event without `by` fails.
- `cli-decisions add` refuses a summary identical to an open decision's summary (the error names it); `--allow-duplicate` overrides.
- For each of the 5 pairs: decide which record is canonical (the one the operator answered, else the later one), supersede the other, and list the choices in the PR body. If both records in a pair were answered with different choices, don't pick: list the pair in the PR body for the planner.

## Acceptance Criteria

- [ ] #1 Tests: each writer emits `by`; an event without `by` is refused.
- [ ] #2 Test: `add` with an open record's exact summary fails and names it; `--allow-duplicate` passes.
- [ ] #3 The 5 pairs each have one canonical record and a supersede event, or the PR body lists the pair as conflicting.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
