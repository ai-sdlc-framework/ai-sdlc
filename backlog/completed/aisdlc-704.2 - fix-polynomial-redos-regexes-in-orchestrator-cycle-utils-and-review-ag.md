---
id: AISDLC-704.2
title: >-
  fix polynomial ReDoS regexes in orchestrator cycle-utils and review-agent
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). Rewrite the polynomial-redos regexes at `orchestrator/src/cycle-utils.ts` (alert 168, tag-strip in sanitizeTemplate) and `orchestrator/src/runners/review-agent.ts` (alert 134) with linear-time logic and tests including a pathological input.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The change described above is implemented with tests.
- [x] The listed code-scanning alerts read `fixed` after merge.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Replaced the polynomial-ReDoS regexes in `sanitizeTemplate` (cycle-utils) and `parseVerdict` (review-agent) with linear string scans, plus tests with 100k-character pathological inputs.

## Changes
- `orchestrator/src/cycle-utils.ts` (modified): `sanitizeTemplate` is now a single `indexOf` scan, exported for testing; one pass is already a fixed point.
- `orchestrator/src/runners/review-agent.ts` (modified): new private `stripFences` helper replaces the two multiline regexes.
- `orchestrator/src/cycle-utils.test.ts`, `orchestrator/src/runners/review-agent.test.ts` (modified): behavior and pathological-input tests.

## Design decisions
- **No regex, linear scans**: equivalence with the old regexes checked on 300k random inputs in an uncommitted scratch script.

## Verification
- `pnpm build` — clean
- `pnpm test` — orchestrator suite 217 files, 5016 tests passed
- `pnpm lint` — clean
- `pnpm format:check` — clean on changed files
- 3 reviewers approved (Claude-native; Codex quota exhausted)

## Follow-up
- declined: stale doc comment above `sanitizeTemplate` still describes the old loop-until-stable approach (comment-only, minor reviewer suggestion).
- declined: additional fence edge-case tests (reviewer minor suggestion).
- declined: AC2 (alerts 168 and 134 read fixed) can only be confirmed after merge, by the code-scanning rescan.
<!-- SECTION:FINAL_SUMMARY:END -->
