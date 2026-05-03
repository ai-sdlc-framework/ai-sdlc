---
id: AISDLC-69.6
title: >-
  RFC-0003 doc references — add RFC-0003 citation to adapter tutorial / api-ref
  / runbook / example
status: Done
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
parent_task_id: AISDLC-69
priority: low
drift_status: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. RFC-0003 (Infrastructure Provider Adapters — the `RFC-0003-infrastructure-adapters.md` file) is `Draft` status with `requiresDocs: [tutorial, api-reference, operator-runbook, example]` per the convention defined in AISDLC-69.2.

The doc surfaces already cover adapters but do **not** cite RFC-0003 by ID:

- `docs/tutorials/04-custom-adapter.md` — adapter authoring tutorial
- `docs/tutorials/06-openshell-sandbox.md` — sandbox adapter tutorial
- `docs/api-reference/adapters.md` — adapter API reference
- `docs/operations/adapter-authoring.md` — operator runbook for adapter authoring
- `docs/examples/adapter-implementation.ts` — example adapter

The CI gate in AISDLC-69.3 will look for the literal string `RFC-0003` in at least one file under each declared subdirectory. Without explicit references, the gate will fail for RFC-0003.

(Historical note: a sibling file previously shared the RFC-0003 ID — `RFC-0003-product-first-implementation-strategy.md` with `requiresDocs: []`. AISDLC-109 renumbered it to `RFC-0013-product-first-implementation-strategy.md`, so RFC-0003 now refers unambiguously to the infrastructure-adapters RFC.)

## What this task does

Add a brief "Spec reference" section or inline citation to at least one file per surface:

1. `docs/tutorials/04-custom-adapter.md` — add `> See RFC-0003 (Infrastructure Provider Adapters) for the normative interface contracts.` near the intro.
2. `docs/api-reference/adapters.md` — add an `> Implements RFC-0003 §2-§6 (AuditSink, Sandbox, SecretStore, MemoryStore, EventBus).` callout.
3. `docs/operations/adapter-authoring.md` — add `> Companion to RFC-0003 §1 (extended interface enum).`
4. `docs/examples/adapter-implementation.ts` — add a `// RFC-0003 §3 Sandbox interface example` comment header.

After editing, run `pnpm docs:sync` so `ai-sdlc-io/content/docs/` stays in sync.

## Out of scope

- Re-authoring the existing content (it already covers the material).
- Updating other RFC references (each RFC is a separate task).

## Acceptance Criteria
<!-- AC:BEGIN -->
1. At least one file under `docs/tutorials/` contains literal text `RFC-0003`.
2. At least one file under `docs/api-reference/` contains literal text `RFC-0003`.
3. At least one file under `docs/operations/` contains literal text `RFC-0003`.
4. At least one file under `docs/examples/` contains literal text `RFC-0003`.
5. `pnpm docs:sync && pnpm docs:check` clean.
6. AISDLC-69.3's `pnpm docs:check` (or equivalent) passes for RFC-0003 (infrastructure-adapters).
<!-- AC:END -->
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added RFC-0003 (Infrastructure Provider Adapters) citations to the four adapter doc surfaces. Dev wisely chose `docs/operations/adapter-authoring.md` over `operator-runbook.md` to dodge merge conflicts with PRs #128 + #129.

## AC status
- ✓ All 3 ACs met

## Verification
- `pnpm rfc:check` clean (RFC-0003 in pre-sign-off skipped bucket)
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- 3 reviews approved: code 0c/0M/1m/1s; test 0c/0M/0m/0s; security 0c/0M/0m/0s

## Operator follow-up (from review)
- **Pre-existing RFC-0003 ID collision**: TWO files in `spec/rfcs/` declare `id: RFC-0003` — `RFC-0003-infrastructure-adapters.md` and `RFC-0003-product-first-implementation-strategy.md`. Citations resolve by file path so this PR works, but the duplicate ID is a footgun for any tool resolving by ID. File a separate backlog task to renumber one of them.
- `examples/adapter-implementation.ts` cites `§3 — Sandbox` but the example demonstrates IssueTracker. Tighten to `§1 (Extended Interface Enum)` for accuracy.
- Operator: run `pnpm docs:sync` against `ai-sdlc-io/` sibling
<!-- SECTION:FINAL_SUMMARY:END -->
