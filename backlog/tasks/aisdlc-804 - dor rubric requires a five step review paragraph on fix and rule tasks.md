---
id: AISDLC-804
title: >-
  DoR rubric and task template require a "Five-step review (requirements first)" paragraph on every task that fixes a failure or adds a rule
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - dor
  - governance
  - velocity
dependencies: []
references:
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - pipeline-cli/src/dor/pr-violations.ts
  - ai-sdlc-plugin/commands/planner.md
  - CLAUDE.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator standing rule (2026-10-10, CLAUDE.md "Five-step production algorithm", DEC-0090): every fix, prevention task, governance rule and process change is worked in the order question requirements, delete, simplify, accelerate, automate, and names the steps. Today the rule lives in prose. Step 5 of the rule itself says automate last, so this task is deliberately small: it makes the Definition-of-Ready evaluation refuse a task that claims to fix a failure or add a rule without the paragraph, and gives authors the template.

**Five-step review (requirements first).** Requirement questioned: "a reviewer checks by eye that a fix questioned its requirement" (set by nobody; it is the absence of a rule). Deleted: nothing to delete, this is net-new and minimal. Simplified: one deterministic Stage A check, no model call. Automated: the check runs where DoR already runs (CI "Evaluate backlog tasks changed by PR" and `cli-dor-check`).

**Fix.**
1. Stage A deterministic DoR gate: when a task carries any of the labels `bug`, `fix`, `stability`, `root-cause`, `governance`, `hooks`, `ci` or its title starts with `fix`, the description must contain a paragraph starting with `**Five-step review` that names a questioned requirement and a deletion (the words "Delete" or "Deleted" or "nothing to delete" must appear). Missing paragraph → `needs-clarification` with the clarifying question quoting the five steps. `blocked.reason` override applies as for every other gate.
2. The planner command body's task template and `docs/operations/decision-authority.md` carry the paragraph template with the five step names.
3. Hermetic tests in `pipeline-cli/src/dor/` for present, missing and overridden cases; the DoR ingress workflow test confirms the new finding renders.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] A task with a fix/rule label and no "Five-step review" paragraph gets `needs-clarification` from the deterministic DoR stage, with the five step names in the clarifying question; a task with the paragraph passes; `blocked.reason` overrides.
- [ ] The planner task template and `docs/operations/decision-authority.md` include the paragraph template.
- [ ] Hermetic tests cover the three cases; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Operator rule 2026-10-10. Related: AISDLC-797..803 (first tasks written under the rule).
