---
id: AISDLC-69.5
title: RFC-0002 doc references — add RFC-0002 citation to pipeline tutorial / api-ref / example
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
  - spec/rfcs/RFC-0002-pipeline-orchestration.md
  - docs/tutorials/01-basic-pipeline.md
  - docs/tutorials/07-workflow-patterns.md
  - docs/api-reference/core.md
  - docs/examples/complete-pipeline.yaml
parent_task_id: AISDLC-69
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. RFC-0002 (Pipeline Orchestration Policy) is `Draft` status with `requiresDocs: [tutorial, api-reference, example]` per the convention defined in AISDLC-69.2.

The doc surfaces themselves already exist and cover the relevant material:

- `docs/tutorials/01-basic-pipeline.md` — pipeline tutorial
- `docs/tutorials/07-workflow-patterns.md` — workflow patterns tutorial
- `docs/api-reference/core.md` — Pipeline API reference
- `docs/examples/complete-pipeline.yaml` — end-to-end example

…but **none of them currently reference RFC-0002 by ID**. The CI gate in AISDLC-69.3 will look for the literal string `RFC-0002` in at least one file under each declared subdirectory. Without explicit references, the gate will fail.

**Hard dependency: AISDLC-69.3 must merge before this task is required** (it's the gate that motivates the work). Authoring can happen in parallel.

## What this task does

Add a brief "Spec reference" section or inline citation to at least one file per surface:

1. `docs/tutorials/01-basic-pipeline.md` OR `07-workflow-patterns.md` — add `> See RFC-0002 (Pipeline Orchestration Policy) for the normative spec.` near the intro.
2. `docs/api-reference/core.md` — add an `> Implements RFC-0002 §5 stage object.` callout in the Pipeline section.
3. `docs/examples/complete-pipeline.yaml` — add a `# RFC-0002 §6 example pipeline` comment header.

After editing, run `pnpm docs:sync` so `ai-sdlc-io/content/docs/` stays in sync.

## Out of scope

- Re-authoring the tutorials/api-ref content (they already cover the material).
- Updating other RFC references (each RFC is a separate task).

## Acceptance Criteria
<!-- AC:BEGIN -->
1. At least one file under `docs/tutorials/` contains literal text `RFC-0002`.
2. At least one file under `docs/api-reference/` contains literal text `RFC-0002`.
3. At least one file under `docs/examples/` contains literal text `RFC-0002`.
4. `pnpm docs:sync && pnpm docs:check` clean.
5. AISDLC-69.3's `pnpm docs:check` (or equivalent) passes for RFC-0002.
<!-- AC:END -->
<!-- SECTION:DESCRIPTION:END -->
