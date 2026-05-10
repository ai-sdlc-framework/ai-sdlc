---
id: AISDLC-202.2
title: 'Phase 2: Codex adapter for developer and reviewer dispatch plus Step 2 slug fallback'
status: To Do
assignee: []
created_date: '2026-05-05 20:15'
labels:
  - rfc-0012
  - codex
  - phase-2
  - implementation
  - pipeline-cli
parentTaskId: AISDLC-202
dependencies:
  - AISDLC-202.1
references:
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/steps/02-compute-branch.ts
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Per the AISDLC-202.1 design map, Codex CLI cannot dispatch plugin agents via Claude Code's `Agent` tool. The AISDLC-201 run hand-rolled the dispatch using Codex `spawn_agent`. This needs to become a reusable adapter that other Codex-driven runs can call without re-deriving the contract each time.

Additionally, the AISDLC-201 run hit a Step 2 branch slug fallback bug — the fallback path produced a malformed branch name that had to be hand-patched. That bug needs a real fix in the deterministic step.

## Goal

Ship a `CodexHarnessAdapter` (or equivalent abstraction) that:
- Wraps Codex `spawn_agent` for developer + 3 reviewer dispatch
- Returns `DeveloperReturn` and reviewer verdict JSON in the schema the rest of the pipeline expects (no manual JSON reshaping needed)
- Is selectable via the existing `--spawner` CLI flag (e.g., `--spawner codex`) or via env detection

Also fix the Step 2 branch slug fallback so it produces valid branch names without manual intervention.

## Implementation notes

The adapter should live alongside the existing spawners in `pipeline-cli/src/spawners/` (or wherever the codex spawner ends up being conventionally placed). Tests should mock Codex's `spawn_agent` interface so the adapter contract is verifiable without a real Codex CLI install.

The Step 2 fix is a separable commit — could ship in a precursor PR.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `CodexHarnessAdapter` (or equivalent) implements developer + 3-reviewer dispatch via Codex `spawn_agent` with the same return-value contract as the Claude Code Agent path.
- [ ] #2 Reviewer verdict JSON returned by the adapter passes through Step 8 aggregation without manual reshaping.
- [ ] #3 The adapter is selectable via `--spawner codex` (or equivalent operator-facing knob) and documented in `pipeline-cli/README.md`.
- [ ] #4 Unit tests mock Codex `spawn_agent` and prove the adapter contract — no real Codex CLI required to run the test suite.
- [ ] #5 Step 2 branch slug fallback bug is fixed so degraded inputs produce a valid branch name without operator intervention; regression test added.
- [ ] #6 New code reaches 80%+ patch coverage.
<!-- AC:END -->
