---
id: AISDLC-69.6
title: RFC-0003 doc references — add RFC-0003 citation to adapter tutorial / api-ref / runbook / example
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
  - spec/rfcs/RFC-0003-infrastructure-adapters.md
  - docs/tutorials/04-custom-adapter.md
  - docs/tutorials/06-openshell-sandbox.md
  - docs/api-reference/adapters.md
  - docs/operations/adapter-authoring.md
  - docs/examples/adapter-implementation.ts
parent_task_id: AISDLC-69
priority: low
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

(Note: there is a sibling RFC-0003 file — `RFC-0003-product-first-implementation-strategy.md` — that has `requiresDocs: []` and is intentionally exempt; this task only addresses the infrastructure-adapters RFC.)

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
