---
id: AISDLC-202
title: Adapt RFC-0012 execute workflow for Codex CLI orchestration
status: To Do
assignee: []
created_date: '2026-05-05 19:11'
updated_date: '2026-05-05 20:15'
labels:
  - enhancement
  - pipeline-cli
  - codex
  - rfc-0012
  - parent
  - developer-experience
dependencies: []
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - CLAUDE.md
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/cli/execute.ts
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
priority: high
blocked:
  reason: 'Umbrella parent task — dispatch sub-phases AISDLC-202.2 through 202.4 directly. 202.1 (Phase 1 design map) Done; 202.2 (adapter), 202.3 (attestation harness), 202.4 (e2e pilot) are the actual dispatchable work items. Parent unblocks when AC #1 (all 4 sub-tasks Done) is met.'
  unblockedBy:
    - AISDLC-202.2
    - AISDLC-202.3
    - AISDLC-202.4
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

RFC-0012 is written around Claude Code Tier 1 assumptions: the slash command body runs in the main Claude Code session, deterministic steps use the shared pipeline CLI/MCP tools, and LLM steps dispatch plugin agents via Claude Code's `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` tool. In Codex CLI, the available orchestration primitives differ: Codex exposes shell/MCP tools plus Codex subagents, but not Claude Code's plugin Agent tool or native plugin-agent runtime.

AISDLC-201 was completed as a Codex-driven manual Tier 1 simulation. It used the shared deterministic steps where practical, but had to use Codex `spawn_agent` reviewers, manually handle a bad Step 2 branch slug fallback, and explicitly construct/sign reviewer verdict input. This works as a stopgap, but it is not a documented or reusable Codex CLI workflow.

## Goal

Define and implement a Codex-compatible execution path that preserves RFC-0012's two-tier boundaries: deterministic steps stay in `@ai-sdlc/pipeline-cli`/MCP, LLM-driven developer and reviewer work uses Codex's available subagent mechanisms, and attestations accurately record the harness context.

## Sub-tasks

This task is split into four phase sub-tasks. Critical path: 202.1 → 202.2 → 202.3 → 202.4. Total wall-clock estimate: 3-4 weeks.

| ID | Title | Phase | Depends on | Wall-clock |
|---|---|---|---|---|
| AISDLC-202.1 | Phase 1: Document Codex execution path + identify gaps | 1 | — | 3 days |
| AISDLC-202.2 | Phase 2: Codex adapter for developer + reviewer dispatch + Step 2 slug fallback fix | 2 | 202.1 | 1-2 weeks |
| AISDLC-202.3 | Phase 3: Attestation harness context + finalization via MCP task_complete | 3 | 202.2, AISDLC-203 | 1 week |
| AISDLC-202.4 | Phase 4: End-to-end verification + dogfood pilot | 4 | 202.3 | 3 days |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All four sub-tasks (AISDLC-202.1 through 202.4) reach Done status.
- [ ] #2 The dogfood pipeline accepts Codex CLI as a documented, supported alternative harness for `ai-sdlc-pipeline execute` runs (parity with the Claude Code Tier 1 path on the dispatchable tasks it can reach).
- [ ] #3 Operator runbook (`docs/operations/operator-runbook.md` or equivalent) documents when to use Codex vs Claude Code, including known limitations.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AISDLC-203 was filed from the AISDLC-201 Codex run: manual completion added a completed task file in the PR worktree while the parent checkout retained the original task file. The Codex workflow adaptation must treat task completion as an authoritative MCP/shared-step operation, not manual file copy/move behavior. AISDLC-202.3 explicitly depends on AISDLC-203 to inherit that fix.

Per-sub-task ACs were lifted out of this parent and into each phase's individual task file. Parent ACs above are durable across phases.
<!-- SECTION:NOTES:END -->
