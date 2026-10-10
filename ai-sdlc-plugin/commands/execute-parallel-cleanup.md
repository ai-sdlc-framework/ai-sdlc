---
name: execute-parallel-cleanup
description: >-
  Retired parallel pane cleanup; use cli-hierarchy (RFC-0051) instead. See docs/operations/cli-hierarchy.md. AISDLC-763.
argument-hint: ""
allowed-tools:
  - Read
model: haiku
---

# /ai-sdlc execute-parallel-cleanup (retired)

This command's prose was retired by AISDLC-763. Launch and supervise parallel work with `cli-hierarchy` cleanup; see [`docs/operations/cli-hierarchy.md`](../../docs/operations/cli-hierarchy.md). The shell path `node pipeline-cli/bin/cli-orchestrator.mjs tick --spawner <kind>` is unchanged. Tell the operator this, then stop.
