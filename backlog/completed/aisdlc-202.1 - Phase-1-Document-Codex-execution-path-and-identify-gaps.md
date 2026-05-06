---
id: AISDLC-202.1
title: 'Phase 1: Document Codex execution path and identify gaps'
status: Done
assignee: []
created_date: '2026-05-05 20:15'
updated_date: '2026-05-05 20:49'
labels:
  - rfc-0012
  - codex
  - phase-1
  - documentation
  - scoping
dependencies: []
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/execute-pipeline.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

RFC-0012's Step 0-13 pipeline is described in Claude Code Tier 1 terms — slash command body uses the `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` tool to dispatch plugin agents. Codex CLI lacks the plugin Agent tool. Before building any Codex adapter, the gap needs to be mapped explicitly: which steps use shared deterministic primitives (pipeline-cli, MCP) and need no change, which steps need a Codex-specific adapter, and what the adapter contracts look like.

## Goal

Produce a written design that lists every Step 0-13 stage, the Claude Code primitive it uses today, the Codex equivalent (or "no equivalent — needs adapter"), and the proposed adapter shape. This is paper-only scoping work — no code changes.

## Implementation notes

The output should be either an RFC addendum (`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md` revision) or a new operator-doc page (`docs/operations/codex-execution-path.md`). The format should make the per-step decisions reviewable in isolation so subsequent phase work can be parallelized across them.

Reference points to incorporate from the AISDLC-201 Codex run:
- Codex `spawn_agent` was used as the reviewer dispatch mechanism — document its contract + limits
- Step 2 branch slug fallback was hand-patched — capture the actual bug + the fix that's needed
- Reviewer verdict JSON had to be reshaped manually — document the shape mismatch
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A documented Codex CLI execution path maps RFC-0012 Steps 0-13 to Codex-available tools and clearly marks the Tier 1 deviations from Claude Code Agent dispatch.
- [x] #2 Each Step is annotated with one of: "no change needed (uses shared deterministic primitives)", "needs Codex adapter (proposed shape: …)", or "blocked / needs upstream change in Codex".
- [x] #3 Known tooling gaps from the AISDLC-201 run are explicitly listed with proposed resolution paths (Step 2 branch slug fallback, reviewer verdict JSON shape, plugin-agent context differences).
- [x] #4 The document is reviewable as a standalone PR — does not depend on subsequent phase implementation work.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented the Phase 1 Codex CLI execution-path design map. Added `docs/operations/codex-execution-path.md`, linked it from the operator runbook and docs index, and documented RFC-0012 Step 0-13 mappings, per-step classifications, proposed Codex adapter contracts, reviewer verdict shape, and AISDLC-201 gap resolutions for Step 2 slug handling, plugin-agent context, verdict JSON reshaping, backlog completion, and the TypeScript spawner bridge.
<!-- SECTION:FINAL_SUMMARY:END -->
