---
id: AISDLC-941
title: 'Incident records and a recurring-mistakes ledger under docs/operations/incidents/'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - docs
  - operations
  - governance
dependencies: []
references:
  - docs/operations/README.md
  - docs/operations/recovery-flows.md
  - docs/operations/gate-audit-2026-10.md
priority: medium
dispatchable: true
---

## Description

Operational incidents (installation API quota exhaustion, a dead webhook forwarder, the DEC id collisions, a frozen PR head on GitHub) are recorded today only in the planner's handoff memory and in chat. Nothing in the repository says what happened, what was ruled, and whether it has happened before. The playbook gap analysis (2026-10-16, gaps 8 and 18) asks for two things: a fixed incident record, and a ledger of mistakes that recur so a rule or automation can be filed when the count justifies it.

**Five-step review (requirements first).**
1. Requirement questioned: "the handoff memory is the incident log". It is per-session, pruned on every rewrite, and invisible to adopters.
2. Delete: nothing to delete; the handoff keeps its operational role.
3. Simplify: one directory, one template, one index file. No tooling in this task; the record is a markdown file a session writes with `Write`.
4. Accelerate: the template has six headings and fits on one screen (what, impact, timeline, ruling, root cause, follow-up).
5. Automate: deferred; a later task may file the record from `cli-decisions escalate`. The ledger is a table (mistake, count, last seen, rule or task that addresses it) that any session appends to.

Velocity impact: neutral now; positive once the ledger shows which mistake to automate next.

## Acceptance Criteria

- [ ] AC-1: `docs/operations/incidents/README.md` holds the template and the ledger table; `docs/operations/README.md` links it.
- [ ] AC-2: The template's six sections are fixed: What happened, Impact, Timeline (UTC), Ruling and who made it (decision id when one exists), Root cause, Follow-up (task ids when filed).
- [ ] AC-3: Four back-filled records for 2026-10-15/16 incidents: installation API quota exhaustion, webhook forwarder death, decision id allocation collisions, PR head frozen on GitHub. Each cites the decision records on `main` that ruled it.
- [ ] AC-4: The ledger starts with the recurring mistakes those four records expose, each row pointing at the rule, doctor check or task that addresses it, or "none yet".
- [ ] AC-5: `pnpm lint` and `pnpm format:check` pass; no code changes.

## Notes

Origin: playbook gap analysis 2026-10-16 (gaps 8 and 18). Docs-only task; no attestation needed.
