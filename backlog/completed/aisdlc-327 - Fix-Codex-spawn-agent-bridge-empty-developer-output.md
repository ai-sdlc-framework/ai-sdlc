---
id: AISDLC-327
title: Fix Codex spawn-agent bridge empty developer output
status: Done
assignee: []
created_date: '2026-05-16 18:51'
labels:
  - bug
  - codex
  - pipeline-cli
  - developer-experience
dependencies: []
references:
  - scripts/codex-spawn-agent-bridge.mjs
  - pipeline-cli/src/runtime/spawners/codex-harness.ts
  - pipeline-cli/src/cli/execute.ts
  - docs/operations/codex-execution-path.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Running `ai-sdlc-pipeline execute AISDLC-326 --run --spawner codex` with `CODEX_SPAWN_AGENT_BIN=scripts/codex-spawn-agent-bridge.mjs` reached Step 5, but the developer stage returned empty output twice. The pipeline stopped with `developer-json-contract-violated` and rolled back successfully.

Observed outcome:

```json
{
  "outcome": "developer-json-contract-violated",
  "notes": "developer subagent violated JSON envelope contract on both turns. initial (failed to parse developer JSON: Unexpected end of JSON input (raw output: \"\")); retry (failed to parse developer JSON: Unexpected end of JSON input (raw output: \"\"))"
}
```

## Goal

Make the Codex spawn-agent bridge reliably return the expected developer JSON envelope or surface a clear bridge/Codex failure before Step 6 parses an empty string.

## Implementation notes

Investigate whether `scripts/codex-spawn-agent-bridge.mjs` is invoking `codex exec` with the right flags for write-capable developer work and whether stdout is the correct source of truth. The bridge currently uses `codex exec -s read-only --skip-git-repo-check --color never --file <promptFile>`, which may be unsuitable for developer agents that must edit files and return a structured envelope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A Codex developer dispatch that exits successfully with empty stdout is treated as a bridge error with actionable diagnostics, not as an empty developer JSON envelope.
- [ ] #2 The bridge invocation is compatible with developer agents that must edit the task worktree, or the unsupported mode is explicitly blocked before task mutation.
- [ ] #3 Tests cover empty stdout, non-zero Codex exit, and successful developer JSON return through the bridge.
- [ ] #4 Documentation explains the expected `CODEX_SPAWN_AGENT_BIN` behavior and any required Codex CLI flags for developer dispatch.
<!-- AC:END -->
