---
id: AISDLC-251
title: Provide canonical CODEX_SPAWN_AGENT_BIN bridge script for --spawner codex path
status: Done
assignee: []
created_date: '2026-05-09'
labels:
  - codex
  - pipeline-cli
  - developer-experience
  - aisdlc-202.4-followup
parentTaskId: AISDLC-202
dependencies:
  - AISDLC-202.2
references:
  - pipeline-cli/src/runtime/spawners/codex-harness.ts
  - docs/operations/codex-execution-path.md
priority: low
---

## Problem

The `--spawner codex` programmatic dispatch path (`CodexHarnessAdapter` via `subprocessCodexSpawnAgent`) requires operators to set `CODEX_SPAWN_AGENT_BIN` to a bridge script that wraps Codex's `spawn_agent` host tool using the JSON-line wire protocol documented in `pipeline-cli/src/runtime/spawners/codex-harness.ts`.

No canonical bridge script is provided. Each operator must implement their own bridge, which is a manual-intervention point that blocks adoption of the `--spawner codex` path.

## Goal

Ship a canonical bridge script at `scripts/codex-spawn-agent-bridge.mjs` (or similar) that operators can set as `CODEX_SPAWN_AGENT_BIN`. The script reads the JSON-line request from stdin, invokes `codex exec` with the appropriate flags, and writes the JSON-line response to stdout.

## Acceptance Criteria

- [ ] #1 `scripts/codex-spawn-agent-bridge.mjs` implements the JSON-line wire protocol from `codex-harness.ts`: reads `{ agentType, systemPrompt, userPrompt, cwd, timeoutMs }` from stdin, invokes `codex exec`, writes `{ output, parsed? }` to stdout.
- [ ] #2 The bridge uses `-s read-only --skip-git-repo-check --quiet --model o4-mini` flags by default, with per-field overrides from the request envelope.
- [ ] #3 `pipeline-cli/README.md` documents: "set `CODEX_SPAWN_AGENT_BIN=$(pwd)/scripts/codex-spawn-agent-bridge.mjs` before running `ai-sdlc-pipeline execute --spawner codex`."
- [ ] #4 The bridge has a hermetic unit test (no real Codex CLI required) that validates the stdin/stdout protocol.
- [ ] #5 `docs/operations/codex-execution-path.md` "Pilot procedure" section updated to reference the canonical bridge script instead of "write your own bridge."
