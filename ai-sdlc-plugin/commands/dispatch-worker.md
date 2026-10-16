---
name: dispatch-worker
description: >-
  Retired Pattern Z Worker loop; use cli-hierarchy (RFC-0051) instead. See docs/operations/cli-hierarchy.md. AISDLC-763.
argument-hint: ""
allowed-tools:
  - Read
model: haiku
rung: 3
bounds: "tightly scoped template prompt over structured inputs; fixed output; no free prose; no retries beyond the caller cap"
---

# /ai-sdlc dispatch-worker (retired)

This command's prose was retired by AISDLC-763. Launch and supervise parallel work with the hierarchy executor sessions (`/ai-sdlc executor`); see [`docs/operations/cli-hierarchy.md`](../../docs/operations/cli-hierarchy.md). The shell path `node pipeline-cli/bin/cli-orchestrator.mjs tick --spawner <kind>` is unchanged. Tell the operator this, then stop.
