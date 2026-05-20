---
id: AISDLC-300
title: 'block: AISDLC-270 dispatch until RFC-0025 OQ walkthrough complete + sweep for other premature impl tasks'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - governance-gap
  - audit
  - block
  - rfc-0025
priority: high
blocked:
  reason: "Task is Done (completed 2026-05-19). RFC-0025 is referenced for audit context only — this task's implementation work predates RFC-0025's Signed Off promotion. Upstream-OQ gate acknowledged."
dependencies: []
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - backlog/tasks/aisdlc-270 - chore-complete-RFC-0025-quality-monitoring-auto-classification.md
  - spec/rfcs/README.md
finalSummary: |
  ## Summary
  Blocked AISDLC-270 from dispatch by adding `blocked.reason` to its frontmatter, swept all `chore-complete-RFC-*` tasks in `backlog/tasks/` and `backlog/completed/`, and wrote an audit report documenting findings.

  ## Changes
  - `backlog/tasks/aisdlc-270 - chore-complete-RFC-0025-quality-monitoring-auto-classification.md` (modified): added `blocked.reason` field referencing RFC-0025 OQ status and lifecycle; existing `dispatchable: false` retained.
  - `docs/audits/2026-05-15-premature-impl-task-sweep.md` (new): audit report listing all 3 chore-complete-RFC-* tasks, their RFC lifecycle + OQ status, block verdicts, and RFC-0025 walkthrough status.

  ## Design decisions
  - **Belt-and-suspenders block**: AISDLC-270 already had `dispatchable: false`; `blocked.reason` was added for documentation and upstream-OQ gate compatibility (AISDLC-296 reads `blocked.reason` to skip the gate for explicitly-acknowledged OQ holds).
  - **No retroactive block on completed tasks**: AISDLC-269 (RFC-0024) and AISDLC-271 (RFC-0031) are in `backlog/completed/`; blocking them would be meaningless. Their OQ drift is tracked via existing Refit tasks.
  - **OQ walkthrough already done**: RFC-0025's 10 OQs were resolved in the 2026-05-15 operator session; AC #5 satisfied by noting the walkthrough is complete in the audit report.

  ## Verification
  - `pnpm build` — clean (docs-only changeset; no source compilation involved)
  - `pnpm test` — clean
  - `pnpm lint` — clean
  - `pnpm format:check` — clean

  ## Follow-up
  - RFC-0025 sign-off (operator promotes lifecycle to Signed Off)
  - AISDLC-302..307 Refit chain execution (actual RFC-0025 implementation)
  - AISDLC-296 ships (permanent upstream-OQ gate, eliminates need for manual blocked.reason)
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two-part: (a) explicitly block AISDLC-270 from dispatch until RFC-0025's 10 OQs are resolved by operator walkthrough, and (b) sweep the rest of the backlog for `chore-complete-RFC-N` tasks that target an RFC with open OQs or at lifecycle < Signed Off — apply the same block pattern.

## Why immediate block

AISDLC-270 sits in `backlog/tasks/` correctly only because no one has dispatched it. There is no enforced gate (AISDLC-296 is the long-term fix). Until AISDLC-296 ships, manual `blocked.reason` is the only protection.

## Scope

### Part A — block AISDLC-270

- Edit `backlog/tasks/aisdlc-270 - chore-complete-RFC-0025-quality-monitoring-auto-classification.md` frontmatter:
  - Add `blocked: { reason: "RFC-0025 has 10 unresolved OQs (§13). Operator walkthrough required before dispatch. Block lifts when RFC-0025 lifecycle ≥ Signed Off." }`
  - Optionally also `dispatchable: false` with `dispatchableReason` per AISDLC-243 convention.

### Part B — sweep + block

- Survey `backlog/tasks/` for tasks matching `chore-complete-RFC-NNNN-*` pattern.
- For each: check the referenced RFC's lifecycle field + count unresolved OQs in §OQ section.
- Apply the same `blocked.reason` to any task pointing at an RFC at lifecycle < Signed Off OR with open OQs.
- Output an audit report: `docs/audits/2026-05-15-premature-impl-task-sweep.md` listing each task + its RFC + the block reason (or "no block needed").

### Part C — schedule the RFC-0025 walkthrough

- File a separate decision-walkthrough task or schedule it directly with the operator.
- Once RFC-0025 §13 OQs are resolved + lifecycle promoted, the AISDLC-270 block lifts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 AISDLC-270 frontmatter has `blocked.reason` referencing RFC-0025 OQ status
- [x] #2 Backlog swept for all `chore-complete-RFC-N` tasks
- [x] #3 Each premature task gets `blocked.reason` applied
- [x] #4 Audit report `docs/audits/2026-05-15-premature-impl-task-sweep.md` written
- [x] #5 RFC-0025 OQ walkthrough scheduled (separate task or operator session)
<!-- AC:END -->
