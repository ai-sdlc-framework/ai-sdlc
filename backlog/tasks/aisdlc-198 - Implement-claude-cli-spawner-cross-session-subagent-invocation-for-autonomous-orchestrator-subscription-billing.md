---
id: AISDLC-198
title: >-
  Implement claude-cli spawner: cross-session subagent invocation for autonomous
  orchestrator subscription billing
status: To Do
assignee: []
created_date: '2026-05-05 02:48'
labels:
  - enhancement
  - pipeline-cli
  - framework-bug
  - rfc-0012
  - rfc-0015
dependencies: []
references:
  - pipeline-cli/src/runtime/
  - pipeline-cli/src/cli/execute.ts
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - docs/operations/orchestrator-promotion.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal

Unblock the autonomous orchestrator (`cli-orchestrator`, RFC-0015) running on **subscription billing** (Claude Code Max) instead of API key. Currently the orchestrator can only run with `--spawner api-key` (paid Anthropic API per dispatch) or `--spawner mock` (plumbing only). The third option `--spawner claude-cli` was stubbed by AISDLC-182 with a documented `not-yet-implemented` error because it requires solving "how does an out-of-process orchestrator invoke subagents in an operator's running Claude Code session."

## Why this matters

- **Cost asymmetry**: subscription = flat fee; API key = per-token cost. For internal dogfood (~10s of dispatches/day), subscription is ~10x cheaper.
- **The orchestrator can't actually run autonomously today** — manual dispatch via the operator's Claude Code session (`Agent` tool) is the ONLY subscription-billed path. The orchestrator is shipped + tested + flag-gated but unused because of this.
- **2026-05-04 dogfood evidence**: 16+ PRs shipped via manual `Agent` tool calls in a single Claude Code session; the orchestrator could have done the dispatching but wasn't enabled because the spawner gap means it would burn API credits.

## Design options to evaluate

1. **Out-of-band queue**: orchestrator emits `Agent` tool-call instructions to a queue (e.g., `_orchestrator/dispatch.jsonl`); the operator's Claude Code session has a slash command (e.g., `/ai-sdlc poll`) that pops + executes. Adds operator latency but uses subscription billing.
2. **MCP server bridge**: claude-cli spawner = an MCP tool that the orchestrator calls to request `Agent` invocation in the operator's session. Operator's session must have the MCP client connected.
3. **Co-located process**: orchestrator runs INSIDE the operator's Claude Code session (via long-running slash command + ScheduleWakeup loop). Today's `/loop /ai-sdlc execute <task-id>` pattern is approximately this — formalize it as `cli-orchestrator start --inline`.
4. **Claude Code SDK extension**: cross-session `Agent` invocation as a first-class API (would require Anthropic SDK changes; longest path).

Recommend evaluating options 1 + 3 first — both can ship without external dependencies.

## Composes with

- **RFC-0015 promotion**: until this lands, `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` flag stays gated; promotion-to-default-on requires soak evidence which requires actually running the orchestrator.
- **AISDLC-182**: provided the umbrella CLI surface (`ai-sdlc-pipeline execute`) that wraps `executePipeline()`. The claude-cli spawner is the missing piece that lets that CLI work without API key.
- **AISDLC-189 / AI_SDLC_PAT**: now that auto-rebase fires CI on rebased SHAs, the queue is reliable enough that autonomous dispatch becomes viable from the queue side.

## Risk
The orchestrator promotion process (Phase 5 of RFC-0015) requires soak evidence + corpus aggregation. This task removes the FIRST blocker (subscription billing). Soak phase still needs to happen before flipping the flag default-on.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Design doc evaluating 4 spawner options with cost/latency/complexity tradeoffs
- [ ] #2 Selected option implemented as --spawner claude-cli in pipeline-cli/src/runtime/
- [ ] #3 End-to-end smoke test: cli-orchestrator tick with --spawner claude-cli dispatches a frontier task on subscription billing
- [ ] #4 AISDLC-182's stub error message updated
- [ ] #5 orchestrator-promotion.md soak-evidence checklist updated
- [ ] #6 Operator runbook entry for starting the orchestrator
<!-- AC:END -->
