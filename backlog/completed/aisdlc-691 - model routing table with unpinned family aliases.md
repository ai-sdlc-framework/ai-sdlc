---
id: AISDLC-691
title: >-
  Land this repository's model routing table with unpinned family aliases
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - model-routing
  - rfc-0050
  - config
dependencies: []
references:
  - .ai-sdlc/model-routing.yaml
  - spec/schemas/model-routing.v1.schema.json
  - pipeline-cli/src/routing/load-table.ts
  - docs/operations/model-routing.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: high
dispatchable: false
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This repository had no `.ai-sdlc/model-routing.yaml`, so every pipeline role resolved
through the built-in defaults, which name old versioned model ids. The operator ruled
on 2026-10-03 that roles follow the latest Sonnet and Opus through family aliases and
that a version is pinned only when a release causes a problem. He asked for the table
to be landed through a task, a worktree and a pull request.

Operator-requested configuration change. Agents do not write under `.ai-sdlc/` on
their own; the operator asked for this file and its location explicitly.

## Scope
1. Add `.ai-sdlc/model-routing.yaml`: developer, code reviewer, test reviewer and the
   staged-review executor on `sonnet`; security reviewer on `opus`;
   `strength: [sonnet, opus]`; no candidates and `exploreShare: 0`, so no exploration.
2. No code change. The built-in defaults that still name versioned ids are a separate
   task, filed in #1173.

## Acceptance Criteria
- [x] `.ai-sdlc/model-routing.yaml` parses with `parseRoutingTable` and loads with `loadRoutingTable` from a ref that contains it.
- [x] Every cell names a family alias; no versioned model id appears in the file.
- [x] The security reviewer cell is `opus` and sits on the strongest `strength` entry; no cell has `candidates`.
- [x] `resolveModel` against a ref that contains the table returns `sonnet` on the `table` arm for developer and `opus` for the security reviewer.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL-SUMMARY:BEGIN -->
## Summary
Adds this repository's model routing table. Pipeline roles now resolve to the family
aliases `sonnet` and `opus` once the file is on `main`, so they follow new releases
without a table edit.

## Changes
- `.ai-sdlc/model-routing.yaml` (new): five role cells on aliases, no exploration.

## Design decisions
- **Aliases, not versioned ids**: operator ruling of 2026-10-03. Tradeoff: scorecards
  group by the name in the table, so results before and after a model release share a
  row. Pinning a cell to a full id is the remedy if a release misbehaves.
- **No planner cell and no model above `opus` in `strength`**: the parser requires the
  security reviewer to sit on the strongest entry when the built-in security model id
  is absent from `strength`, so adding a stronger model would invalidate the table.
  The planner session's model is chosen where that session is launched.
- **`review-executor` cell included now**: AISDLC-675 needs it as an operator step, and
  an unused cell is inert.

## Verification
- `parseRoutingTable` on the file: ok.
- `loadRoutingTable` and `resolveModel` against the branch head: table arm, `sonnet`
  for developer, `opus` for security reviewer.
- `prettier --check` on the file: clean.

## Follow-up
- #1173: files the task for the built-in defaults and fallbacks that still name versioned ids.
- AISDLC-656.2: `route apply` should write aliases by default.
<!-- SECTION:FINAL-SUMMARY:END -->
