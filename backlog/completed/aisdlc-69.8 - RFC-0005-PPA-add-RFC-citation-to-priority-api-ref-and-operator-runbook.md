---
id: AISDLC-69.8
title: RFC-0005 PPA — add RFC citation to priority api-ref and operator runbook
status: To Do
assignee: []
created_date: '2026-04-30 17:35'
updated_date: '2026-04-30 17:35'
labels:
  - docs
  - content
  - rfc-process
  - follow-up
  - aisdlc-69
dependencies:
  - AISDLC-69.2
references:
  - spec/rfcs/RFC-0005-product-priority-algorithm.md
  - docs/api-reference/priority.md
  - docs/operations/operator-runbook.md
parent_task_id: AISDLC-69
priority: low
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: dep-resolved
    detail: Dependency AISDLC-69.2 has been completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. RFC-0005 (Product Priority Algorithm) declares `requiresDocs: [api-reference, operator-runbook]` per the convention defined in AISDLC-69.2. Current state:

- `docs/api-reference/priority.md` — exists and covers PPA, but references RFC-0008 (Triad Integration) and not RFC-0005 (the underlying PPA spec).
- `docs/operations/operator-runbook.md` — references RFC-0008 only, not RFC-0005.

The CI gate in AISDLC-69.3 will look for literal `RFC-0005` in at least one file per declared subdirectory.

## What this task does

1. **Update `docs/api-reference/priority.md`** — add a "Spec references" section at the top citing `RFC-0005 (Product Priority Algorithm)` as the foundational spec and `RFC-0008 (PPA Triad Integration)` as the integration layer. One sentence per RFC explaining the relationship.
2. **Update `docs/operations/operator-runbook.md`** — change the existing PPA scoring callout from `**PPA scoring** (RFC-0008)` to `**PPA scoring** (RFC-0005, integrated via RFC-0008)`.

After editing, run `pnpm docs:sync` so `ai-sdlc-io/content/docs/` stays in sync.

## Out of scope

- Authoring a new PPA tutorial (PPA is operator-facing, not consumer-facing — the runbook is sufficient).
- Re-authoring the priority.md content.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `docs/api-reference/priority.md` contains literal text `RFC-0005`.
2. `docs/operations/operator-runbook.md` contains literal text `RFC-0005`.
3. `pnpm docs:sync && pnpm docs:check` clean.
4. AISDLC-69.3's `pnpm docs:check` (or equivalent) passes for RFC-0005.
<!-- AC:END -->
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added RFC-0005 (Product Priority Algorithm) citations to docs/api-reference/priority.md (new "Spec references" section) and docs/operations/operator-runbook.md (PPA scoring callout, required-reading list, Related Documents).

## AC status
- ✓ All 4 ACs met (rfc:check skips pre-sign-off RFCs; gate will pass once RFC-0005 reaches Approved)

## Verification
- `pnpm rfc:check` clean (8 RFCs walked)
- `pnpm rfc:test` 46/46
- `pnpm build && pnpm lint && pnpm format:check` clean
- 3 reviews approved: code 0c/0M/1m/0s; test 0c/0M/0m/0s; security 0c/0M/0m/0s
- ⚠ INDEPENDENCE NOT ENFORCED

## Follow-up
- Code minor: `priority.md` line 7 says RFC-0005 "defines the seven dimensions" — RFC-0005's Summary uses "five dimensions plus bounded human influence and self-calibrating feedback"; tighten phrasing
- Operator: run `pnpm docs:sync` against `ai-sdlc-io/` for sibling propagation
<!-- SECTION:FINAL_SUMMARY:END -->
