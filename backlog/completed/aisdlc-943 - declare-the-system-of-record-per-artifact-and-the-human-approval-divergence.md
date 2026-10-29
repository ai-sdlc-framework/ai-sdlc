---
id: AISDLC-943
title: >-
  Docs: declare the system of record per artifact and where this project
  diverges from human-approval stages
status: Done
assignee: []
created_date: '2026-10-16'
updated_date: '2026-10-16 18:30'
labels:
  - docs
  - governance
dependencies: []
references:
  - docs/operations/backlog-and-execution-reference.md
  - docs/operations/decision-authority.md
  - spec/rfcs/README.md
  - docs/operations/README.md
priority: medium
drift_log:
  - date: '2026-10-16'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      docs/operations/decision-catalog-promotion.md
    resolution: flagged
drift_checked: '2026-10-16'
---

## Description

Four stores hold project state: backlog task files, GitHub issues and PRs, the decision catalog, and RFCs. Which one wins when they disagree is stated piecemeal (the execution reference says the issue is the source of truth on the gh-issue path and the task file location is the source of truth for completion; the decision-authority doc says a record on `main` is authority) and never in one place. Separately, the AI-native SDLC playbook puts a human approval at the plan and the release; this project replaces most of those with the decision rubric and class (c) escalation, and nothing says so to an adopter. The gap analysis (2026-10-16, gaps 12 and 20) asks for one page that does both.

**Five-step review (requirements first).**
1. Requirement questioned: "adopters infer the system of record from the reference docs". They cannot; the statements are spread over three files and one hook.
2. Delete: nothing to delete; existing statements stay where they are and the new page links to them.
3. Simplify: one table (artifact, system of record, who writes it, what overrides it) and one short section on approval divergence.
4. Accelerate: the page is the first link under Governance in the operations README.
5. Automate: nothing to automate.

Velocity impact: neutral; removes a class of "which file wins" questions to the planner.

## Acceptance Criteria

- [ ] AC-1: `docs/operations/system-of-record.md` holds a table with one row per artifact: backlog task, GitHub issue, PR, decision record, RFC, dispatch board (`.ai-sdlc/dispatch/`), attestation envelope, handoff memory. Columns: system of record, writer, what overrides it, where the rule is stated today (link).
- [ ] AC-2: A section "Human approval: where this project diverges from the playbook" lists each playbook approval point (plan, merge, release, policy change) and the project's replacement (decision class, rubric, gate or operator-only step) with a link to the governing doc.
- [ ] AC-3: The page is linked from `docs/operations/README.md` and from `decision-authority.md`.
- [ ] AC-4: No existing doc is rewritten; at most a one-line pointer is added to each.
- [ ] AC-5: `pnpm lint` and `pnpm format:check` pass; docs-only.

## Notes

Origin: playbook gap analysis 2026-10-16 (gaps 12 and 20).
