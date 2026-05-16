---
id: AISDLC-326
title: Allow cli-orchestrator tick to dispatch with Codex spawner
status: Done
assignee: []
created_date: '2026-05-16 18:27'
labels:
  - enhancement
  - orchestrator
  - codex
  - pipeline-cli
  - developer-experience
dependencies: []
references:
  - pipeline-cli/src/cli/orchestrator.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/runtime/spawners/codex-harness.ts
  - scripts/codex-spawn-agent-bridge.mjs
  - docs/operations/orchestrator-runbook.md
  - docs/operations/codex-execution-path.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When Claude is unavailable, operators can dispatch an individual backlog task with `ai-sdlc-pipeline execute <task-id> --run --spawner codex`, but `cli-orchestrator tick` cannot currently select Codex as its autonomous dispatch spawner. The orchestrator production path defaults to the legacy direct spawner or the umbrella path with `claude-cli`, and the documented fallback only supports `api-key`.

This means the autonomous frontier picker cannot keep working during Claude outages even though the Codex execution path exists and has a canonical `CODEX_SPAWN_AGENT_BIN` bridge.

## Goal

Add an operator-facing way for `cli-orchestrator tick` and `cli-orchestrator start` to dispatch admitted tasks through the Codex spawner. The design should preserve the existing safe defaults and require explicit opt-in for Codex.

## Implementation notes

Likely shape: add an env var and/or CLI flag such as `AI_SDLC_ORCHESTRATOR_SPAWNER=codex` or `--spawner codex`, thread it into `umbrellaSpawnerKind`, require `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1` when needed, and ensure `CODEX_SPAWN_AGENT_BIN` validation fails before task mutation when Codex is selected but not configured.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `cli-orchestrator tick` can explicitly select Codex dispatch for admitted tasks via a documented env var or CLI flag.
- [ ] #2 `cli-orchestrator start` uses the same Codex spawner selection mechanism as `tick`.
- [ ] #3 Codex selection uses the existing `CodexHarnessAdapter` / `CODEX_SPAWN_AGENT_BIN` path and fails before task mutation when the bridge is not configured.
- [ ] #4 The default orchestrator behavior remains unchanged when no Codex spawner selection is provided.
- [ ] #5 Unit tests cover Codex spawner selection, missing bridge failure, and preservation of existing Claude/API-key fallback behavior.
- [ ] #6 Operator docs describe how to run `cli-orchestrator tick` with Codex while Claude is unavailable.
<!-- AC:END -->
