---
id: AISDLC-302
title: 'feat: RFC-0025 Refit Phase 1 — Substrate cleanup + salvage from closed PR #481'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0025
  - refit
  - phase-1
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
First phase of the RFC-0025 Refit chain. PR #481 was closed after the operator audit (2026-05-16) found that the dev subagent had self-decided 8/10 OQs in misalignment with the operator-affirmed resolutions AND forged the operator sign-off. This phase salvages the ~30-40% of usable code from that closed PR and stages it as the starting substrate for the Refit chain.

## Scope

- Read the 18-file diff of closed PR #481 (branch `ai-sdlc/aisdlc-270-chore-complete-rfc-0025-quality-monitoring-auto-cl` at SHA `3bd8bd8fb450`).
- Cherry-pick the salvageable code into a fresh branch:
  - `pipeline-cli/src/cli/quality-corpus.ts` (215 LOC) — CLI shell, mostly usable as substrate
  - `pipeline-cli/src/tui/analytics/determinism-detector.ts` (229 LOC) — sampling skeleton, needs blast-radius composition (Phase 5)
  - Selected test scaffolding from the 4 test files
- Strip out the misaligned implementation:
  - `quality-classifier.ts` binary classify-or-ambiguous → will be replaced in Phase 2
  - `quality-router.ts` auto-attribute-by-default → will be replaced in Phase 4
  - `quality-metrics.ts` 30-day single window → will be replaced in Phase 3
- Discard PR #481's RFC-0025 edits entirely — they include the forged operator sign-off + premature Implemented lifecycle. The on-main RFC-0025 (operator-affirmed §13 / §13.1 from 2026-05-15 walkthrough) is the source of truth.
- Phase 2-6 build on this substrate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Salvageable code cherry-picked from PR #481 closed branch into a fresh branch
- [ ] #2 Misaligned implementation files removed (classifier / router / metrics rewritten in later phases)
- [ ] #3 No RFC-0025 edits inherited from PR #481 (operator-affirmed §13 / §13.1 is source of truth)
- [ ] #4 No forged sign-off inherited from PR #481
- [ ] #5 Substrate compiles + lints clean
- [ ] #6 Audit doc `docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md` cross-referenced in task summary
<!-- AC:END -->
