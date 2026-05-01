---
id: AISDLC-116
title: Promote AI_SDLC_PARALLELISM feature flag to default-on
status: Done
assignee: []
created_date: '2026-05-01 16:24'
labels:
  - rfc-0010
  - phase-5-followup
  - feature-flag
  - promotion
dependencies: []
references:
  - orchestrator/src/runtime/parallelism-flag.ts
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - backlog/completed/aisdlc-70.8 - Phase-5-Hardening.md
  - CHANGELOG.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

AISDLC-70.8 (RFC-0010 Phase 5 hardening) shipped with AC #4 unchecked: "After 1 week of dogfood pipeline running with `AI_SDLC_PARALLELISM=experimental`, promote feature flag to default-on." That AC was a calendar-based soak gate.

Per maintainer directive (2026-05-01): arbitrary calendar gates are not blockers. The substantive readiness gate is "no parallelism-related incidents in the trailing observation window." This task does the actual flag flip + closes 70.8 + 70 parent.

## Why this is filed as a separate task vs reopening 70.8

70.8 was marked Done in good faith — most of the hardening work shipped. Only the calendar-gated promotion was deferred. Filing this as a discrete follow-up is cleaner than reopening 70.8 and keeps the audit trail clear.

## Operator pre-flight

Before dispatching dev, run:
```bash
grep -rE '(parallelism|worktree.*conflict|merge.*gate.*fail|WorktreeOwnershipMismatch|RebaseConflict)' \
  orchestrator/_events.jsonl 2>/dev/null | tail -50
```

If any incidents in the trailing 7 days, do NOT promote — file a separate task to triage. Otherwise dispatch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Feature flag `AI_SDLC_PARALLELISM` defaults to `enabled` (not `experimental`) in `orchestrator/src/runtime/parallelism-flag.ts` (or wherever the resolver lives)
- [ ] #2 Existing `experimental` opt-in path still works for callers that explicitly want it (don't break backwards compat)
- [ ] #3 Pre-flight check runs first: scan `orchestrator/_events.jsonl` (or equivalent) for any parallelism-related incidents in the trailing 7 days; if any found, file a follow-up task and skip the promotion (don't ship)
- [ ] #4 spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md revision history extended with v22 entry: 'Feature flag promoted to default-on per maintainer directive 2026-05-01 — corpus-driven not calendar-driven'
- [ ] #5 CHANGELOG.md gets an entry under Unreleased > Added
- [ ] #6 AISDLC-70.8 AC #4 + AISDLC-70 (parent) AC #2 are unblocked as part of this PR's chore commit (parent task can then close)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Per maintainer directive 2026-05-01, dropped the 1-week calendar soak gate (RFC-0010 Phase 5 / AISDLC-70.8 AC #4) in favor of substantive readiness checks. Pre-flight scan of orchestrator/_events.jsonl + trailing 7-day commit log: zero parallelism-related incidents. Promoted AI_SDLC_PARALLELISM default from off to on; backward-compat (experimental opt-in, off/disabled/false/0 opt-out) preserved; unknown values now fail-on (was fail-off) so typos don't silently disable.

## ACs satisfied
- ✓ #1 Default-on flip in parallelism-flag.ts
- ✓ #2 Backward-compat experimental path preserved (4 covering tests)
- ✓ #3 Pre-flight scans both clean
- ✓ #4 RFC-0010 v22 entry added
- ✓ #5 CHANGELOG entry under Unreleased > Added (orchestrator/CHANGELOG.md)
- ✓ #6 AISDLC-70.8 AC #4 + AISDLC-70 parent AC #2 unblocked

## Verification
- pnpm build && pnpm test (2938/2938 orchestrator) && pnpm lint && pnpm format:check — clean
- 3 reviews APPROVED: code 0c/0M/2m/1s; test 0c/0M/0m/0s; security 0c/0M/0m/0s

## Follow-up (reviewer minors, all non-blocking)
- docs/operations/operator-runbook.md still describes the soak window; needs doc drift cleanup
- One-time console.warn for unknown values would surface operator typos at runtime
<!-- SECTION:FINAL_SUMMARY:END -->
