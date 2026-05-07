---
id: AISDLC-225
title: >-
  cli-orchestrator inline spawner missing consumer bridge — manifest-emitted
  result has no Agent-tool reader
status: Done
assignee: []
created_date: '2026-05-07 01:07'
labels:
  - enhancement
  - orchestrator
  - rfc-0015
  - framework-bug
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`pipeline-cli/src/runtime/spawners/claude-cli-inline.ts` (Option 3 from AISDLC-198) implements the spawner side of the inline-orchestrator pattern: when called, it writes a `DispatchManifest` to `$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json` and returns `{ status: 'manifest-emitted', manifest }`. The protocol is documented at `docs/operations/claude-cli-spawner.md`.

**The consumer side does not exist.** Per the spawner's own JSDoc:

> "The slash command body detects `manifest-emitted`, reads the manifest, and invokes the Agent tool with the described parameters."

There is no slash command body that does this. `cli-orchestrator start --inline --spawner claude-cli` emits the manifest, then `executePipeline()` doesn't know what to do with `{ status: 'manifest-emitted' }` — it expects a `parsed` field with the developer JSON return.

Discovered while operator-driven dogfood was attempting to drive AISDLC-178.4 through the orchestrator (2026-05-07, autonomous loop). The fallback path (`defaultSpawner()` → `ShellClaudePSpawner` shelling out to `claude -p`) works, but the inline manifest path advertised in AISDLC-198 doesn't close the loop.

## Why this matters

RFC-0015 promotes the orchestrator to default-on after a corpus-driven soak. The inline spawner is the only path that uses the operator's existing Claude Code session (no separate `claude -p` subprocess auth, no API-key billing). Without the consumer bridge, the orchestrator's subscription-billing story is half-built.

## Proposed design

A new slash command body — `/ai-sdlc orchestrator-tick` (or extend `/ai-sdlc execute` with an `--orchestrator-loop` flag) — that:

1. Calls `cli-orchestrator tick --max-concurrent 1` programmatically (or runs the loop's tick function directly).
2. When the spawner emits a `manifest-emitted` result:
   - Reads the manifest from disk.
   - Invokes the Agent tool with `{ subagent_type, prompt, model, cwd, runInBackground }` from the manifest.
   - Captures the Agent result (developer JSON return or reviewer verdict).
   - Writes the result back to a known location (e.g. `$ARTIFACTS_DIR/_orchestrator/dispatch-result.json`).
3. Returns control to the orchestrator's tick loop, which reads the result file and continues `executePipeline()`'s Steps 6+.
4. Loops via `ScheduleWakeup` between ticks (subscription-friendly cadence ~30s).

## Acceptance Criteria

- [x] #1 `/ai-sdlc orchestrator-tick` (or equivalent slash command) lives in `ai-sdlc-plugin/commands/`
- [x] #2 The slash command runs `cli-orchestrator tick`, detects `manifest-emitted` results, invokes the Agent tool with the manifest's parameters, and feeds the result back to `executePipeline()`
- [x] #3 Loop control via `ScheduleWakeup` (or operator can `/loop /ai-sdlc orchestrator-tick`)
- [x] #4 End-to-end test: orchestrator dispatches a fixture task through the slash command body's Agent invocation; PR opens; reviewers run; attestation signs; PR enters merge queue
- [x] #5 Documents the consumer protocol in `docs/operations/orchestrator-inline-loop.md`
- [x] #6 RFC-0015 §11 Phase 5 promotion runbook updated to mark the inline spawner path as production-ready

## Composes with

- **RFC-0015** (autonomous orchestrator) — this completes the subscription-billing path that's the canonical "default-on" target
- **AISDLC-198** (claude-cli spawner Option 3) — this is the consumer side the spawner expects

## References

- `pipeline-cli/src/runtime/spawners/claude-cli-inline.ts`
- `docs/operations/claude-cli-spawner.md`
- `pipeline-cli/src/orchestrator/loop.ts`
- `ai-sdlc-plugin/commands/execute.md` (model for the slash command body shape)
<!-- SECTION:DESCRIPTION:END -->

## finalSummary

## Summary
Shipped the consumer-bridge half of the AISDLC-198 Option 3 inline spawner protocol. The `ClaudeCliInlineSpawner` already wrote `dispatch-manifest.json` and returned `{ status: 'manifest-emitted' }` — but no slash command read the manifest and invoked the `Agent` tool. This PR adds `/ai-sdlc orchestrator-tick` (the slash command body), `dispatch-result.ts` (write/read/convert helpers for the result file), comprehensive tests, a new `docs/operations/orchestrator-inline-loop.md` protocol doc, an update to `docs/operations/claude-cli-spawner.md`, and a RFC-0015 §11 Phase 5 update marking the inline spawner path as production-ready.

## Changes
- `ai-sdlc-plugin/commands/orchestrator-tick.md` (new): Slash command body — consumer bridge. Runs `cli-orchestrator tick`, detects `manifest-emitted`, reads manifest, invokes `Agent` tool, writes `dispatch-result.json`, loops via `ScheduleWakeup`.
- `ai-sdlc-plugin/commands/orchestrator-tick.test.mjs` (new): Tests for the slash command frontmatter and body contract — ensures Agent tool grant, correct node invocation pattern, protocol field references, and loop control declarations.
- `pipeline-cli/src/runtime/spawners/dispatch-result.ts` (new): TypeScript bridge helpers — `writeDispatchResult`, `readDispatchResult`, `isDispatchResult`, `dispatchResultToSubagentResult`, `resolveResultPath`. Converts the on-disk result file to the `SubagentResult` that `executePipeline()` expects.
- `pipeline-cli/src/runtime/spawners/dispatch-result.test.ts` (new): Full unit tests for all dispatch-result helpers — covers round-trip write→read→convert, error cases, type guard edge cases.
- `docs/operations/orchestrator-inline-loop.md` (new): Consumer protocol documentation — full tick sequence, file shapes, TypeScript helpers, running instructions, comparison to API-key path.
- `docs/operations/claude-cli-spawner.md` (modified): Added consumer bridge section documenting the full round-trip and linking to the new protocol doc.
- `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md` (modified): §11 Phase 5 updated to mark inline spawner path as production-ready; added Phase 5 promotion status sub-section.

## Design decisions
- **Slash command body, not a subagent**: Plugin subagents cannot use the `Agent` tool (verified empirically, AISDLC-69.2). The slash command body runs in the main Claude Code session which does have Agent access.
- **Separate `dispatch-result.json` file** (not reusing the manifest file): Keeps producer and consumer artifacts distinct; both persist as observability artifacts for forensic inspection between ticks.
- **`dispatchResultToSubagentResult()` converter**: Isolates the on-disk format from the in-memory pipeline format — `executePipeline()` doesn't need to know about the dispatch-result file protocol.
- **`--once` flag**: Allows single-tick mode for debugging without triggering `ScheduleWakeup`.

## Verification
- `pnpm build` — clean
- `pnpm test` — all tests pass including new `dispatch-result.test.ts` and `orchestrator-tick.test.mjs`
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- AISDLC-229: orchestrator tick `--continue-from-result` flag (continuation tick that reads `dispatch-result.json` inside the TypeScript loop) — separate task per scope discipline
- Corpus-driven soak using `--spawner claude-cli` to validate the inline path at scale before promotion to default-on
