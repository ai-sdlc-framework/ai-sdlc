---
id: AISDLC-628
title: 0.21.0 adopter-brick post-mortem + fail-soft-at-the-adopter-boundary principle
status: Done
priority: medium
labels:
  - docs
  - post-mortem
  - regression-prevention
  - adopter
created: 2026-09-18
---

## Context

The 0.21.0 adopter-brick (reviewer subagents hard-refused in adopter repos →
whole pipeline unable to merge) needed a durable written root-cause so the
failure family — **a shared surface changed while a consumer/environment we
don't run locally is left behind** — is not re-learned the hard way. The
specific design misstep (a trust gate placed in the adopter's critical path
instead of at the artifact boundary) also needed to be captured as a reusable
principle.

## Scope

1. **Post-mortem** at `docs/audits/2026-09-18-0.21.0-adopter-brick.md`: impact,
   the three compounding root causes, why our own green pipeline never caught it,
   the deeper pattern (incl. the AISDLC-624 recurrence), the prevention table
   (AISDLC-623/625/626/627/628), and lessons.
2. **Principle doc** at `docs/operations/fail-soft-at-the-adopter-boundary.md`:
   the rule (protect artifacts at the artifact boundary, keep the adopter loop
   running; fail-soft on *absent* input, fail-closed on *unsafe present* input),
   a checklist for new adopter-facing gates, and an audit of current
   adopter-critical-path gates.

## Acceptance Criteria

- [x] `docs/audits/2026-09-18-0.21.0-adopter-brick.md` exists with root cause,
      detection-gap analysis, prevention table, and lessons.
- [x] `docs/operations/fail-soft-at-the-adopter-boundary.md` exists with the
      principle, the absent-vs-unsafe-present distinction, a new-gate checklist,
      and an audit of current adopter-facing gates.
- [x] Both docs are cross-linked with CONTRIBUTING.md (AISDLC-627).
- [x] Docs-only change; `npx backlog-drift check` passes; prettier clean.

## Notes

Docs-only. Shipped together with AISDLC-627 in a single PR (see that task's
Notes for why the atomic landing is required).
