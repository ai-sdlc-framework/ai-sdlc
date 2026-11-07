---
id: AISDLC-671
title: >-
  RFC-0051 results note from production logs (closes the supervised-run requirement)
status: Done
assignee: []
created_date: '2026-09-30'
updated_date: '2026-11-07 00:00'
labels:
  - rfc-0051
  - dispatch
  - docs
dependencies:
  - AISDLC-666
  - AISDLC-667
  - AISDLC-668
  - AISDLC-669
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - docs/operations/cli-hierarchy.md
  - pipeline-cli/bin/cli-usage.mjs
priority: high
dispatchable: true
dispatchableReason: 'Re-scoped and unparked 2026-11-07 by operator ruling (decision rubric, planner session): a docs-only results note from production telemetry, no operator rehearsal.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Size S, docs only. Originally filed as the operator's first supervised run of the session
hierarchy. The hierarchy has since been the default executor path for weeks, so the
evidence the supervised run was meant to produce already exists in production logs. This
task writes it up.

## Ruling 2026-11-07 (operator, decision rubric)

Option A. AISDLC-671 was written as the operator's first supervised hierarchy run, but the hierarchy has been the default executor path for weeks (225 landed items, a 217 MB reconcile log). SRE readiness reviews accept production telemetry in place of a rehearsal. Counter-argument: "supervised" meant a human watching failure modes; rebutted because the operator handled those incidents live and each is a recorded decision. A staged run would be theatre; the note is the evidence AISDLC-772 can cite.

This ruling supersedes DEC-0274's mark-non-dispatchable option for this task (operator
ruling 2026-11-07, recorded in DEC-0393 once filed).

## Scope
An agent writes `docs/operations/hierarchy-results-2026-11.md` from a 7-day window of
production telemetry. No code changes; the only file added is the note, under
`docs/operations/` (link it from `docs/operations/README.md` if that index lists
operations notes).

The note contains:
1. **Window and sources:** the 7-day window chosen, taken from
   `.ai-sdlc/dispatch/log/reconcile.log` (reconciler ticks, outcomes, parks and
   requeues) and `.ai-sdlc/dispatch/drain-stall.json` (stall detections and resumes).
   These files are local runtime state, not tracked; the note quotes counts and
   representative lines, never the whole log.
2. **Throughput:** the `done/` count (landed items) at the end of the window, and
   tasks completed through the hierarchy inside the window.
3. **Per-role usage:** units per role (planner, dispatch, executor) for the window from
   the usage ledger via `node pipeline-cli/bin/cli-usage.mjs`.
4. **Observed failure modes:** the incident decisions DEC-0377, DEC-0382, DEC-0383,
   DEC-0384, DEC-0391 and DEC-0392, one line each: what stalled or failed, and what the
   decision changed. These stand in for the stall log the original task asked the
   operator to keep by hand.
5. **Closing evidence:** a statement that this note is the closing evidence for
   AISDLC-668.3 (brief-notify delivery) and AISDLC-823.1 (scheduled dispatch tick
   AC-6), both already closed citing it, and that it satisfies the RFC-0051 supervised
   run requirement.
6. **What the next period needs:** the short list of changes the failure modes point
   at, each naming the task or decision that already covers it, or "none filed".

## Acceptance Criteria
- [ ] `docs/operations/hierarchy-results-2026-11.md` exists, names its 7-day window and its two log sources, and cites RFC-0051.
- [ ] The note records the `done/` count and the per-role usage figures from `cli-usage` for the window.
- [ ] DEC-0377, DEC-0382, DEC-0383, DEC-0384, DEC-0391 and DEC-0392 each have one line under observed failure modes.
- [ ] The note states it is the closing evidence for AISDLC-668.3 and AISDLC-823.1.
- [ ] The PR touches only `docs/operations/` (the note and, if applicable, the README index line); `pnpm format:check` passes.
<!-- SECTION:DESCRIPTION:END -->
