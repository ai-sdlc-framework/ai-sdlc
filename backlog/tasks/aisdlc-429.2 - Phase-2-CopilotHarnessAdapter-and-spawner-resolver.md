---
id: AISDLC-429.2
title: 'Phase 2: `CopilotHarnessAdapter` + `--spawner copilot` resolver'
status: To Do
labels:
  - rfc-0012
  - copilot
  - phase-2
  - implementation
  - pipeline-cli
parentTaskId: AISDLC-429
dependencies:
  - AISDLC-429.1
assumes:
  - RFC-0012
references:
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/runtime/spawners/codex-harness.ts
  - pipeline-cli/src/runtime/spawners/codex-harness.test.ts
  - pipeline-cli/src/runtime/subagent-spawner.ts
  - pipeline-cli/src/types.ts
priority: high
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Per the AISDLC-429.1 design map (Phase 1), the `copilot` CLI exposes a coding-agent invocation surface that the AI-SDLC pipeline can dispatch through, but it does not match Claude Code's plugin `Agent` tool. A reusable adapter is needed so any operator wiring (`cli-execute`, `cli-orchestrator tick`, programmatic `executePipeline()`) can select `--spawner copilot` and get the same `SubagentSpawner` contract the other spawners satisfy.

## Goal

Ship a `CopilotHarnessAdapter` (callback-driven, host-agnostic) plus a default subprocess bridge (`subprocessCopilotSpawnAgent()`) that shells out to the `copilot` CLI per the Phase 1 grammar. Wire the new kind into `SpawnerKind` and `resolveSpawner()` so `--spawner copilot` is a first-class operator knob. Tests mock the bridge — no real `copilot` binary required in CI / contributor laptops.

This phase deliberately does NOT touch the orchestrator umbrella flag, README tables, or operator runbook — those land in Phase 3 (AISDLC-429.3) on top of this phase's code surface.

## Implementation notes

- Place new code under `pipeline-cli/src/runtime/spawners/copilot-harness.{ts,test.ts}`, parallel to `codex-harness.{ts,test.ts}`. Mirror the type surface (`CopilotSpawnAgentRequest` / `CopilotSpawnAgentResponse` / `CopilotSpawnAgentFn` / `CopilotHarnessAdapterOptions`).
- `CopilotHarnessAdapter implements SubagentSpawner` — `spawn()` + `spawnParallel()` symmetric with codex.
- Per-`SubagentType` default system prompts: minimal "behave like the ai-sdlc `<type>`" strings. Operators wanting full plugin-agent bodies pass `systemPrompts: { developer: readFile('agents/developer.md'), ... }` at construction time.
- Response normalisation: `developer` → `DeveloperReturn` (consumed by Step 6 `parseDeveloperReturnWithRetry`); reviewers → `{approved, findings, summary, harness:'copilot'}` (consumed by Step 7b `coerceReviewerVerdict` without reshaping).
- Default subprocess bridge:
  1. Prefer `$COPILOT_SPAWN_AGENT_BIN` when set — lets operators wrap the CLI in their own auth/transport.
  2. Otherwise resolve `copilot` on PATH and shell out per the Phase 1 grammar.
  3. Use `child_process.spawn` (not `execFile`) so stdout/stderr stream without buffering the full transcript.
  4. Honour per-call `timeoutMs` from the request.
- `SpawnerKind` (in `pipeline-cli/src/cli/execute.ts`) extended to `'mock' | 'api-key' | 'claude' | 'codex' | 'copilot'`. `SPAWNER_KINDS` array updated. The `default:` exhaustiveness check in `resolveSpawner()` still compiles.
- `resolveSpawner('copilot')` constructs the adapter wired to the default bridge. If neither `copilot` is on PATH nor `$COPILOT_SPAWN_AGENT_BIN` is set, throws a clear "configure COPILOT_SPAWN_AGENT_BIN or install the `copilot` CLI" error BEFORE any pipeline mutation (mirrors the `codex` resolver's pre-flight pattern).

The orchestrator umbrella + docs work intentionally lives in Phase 3 so this PR stays focused on the runtime surface.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 New file `pipeline-cli/src/runtime/spawners/copilot-harness.ts` exports `CopilotHarnessAdapter implements SubagentSpawner` via injected `CopilotSpawnAgentFn`. Type surface parallels `codex-harness.ts`.
- [ ] #2 New file `pipeline-cli/src/runtime/spawners/copilot-harness.test.ts` covers (a) developer dispatch round-trip with mocked `spawnAgent` returning a `DeveloperReturn`, (b) each of the three reviewer dispatches returning `{approved, findings, summary, harness:'copilot'}` and passing through `coerceReviewerVerdict` unchanged, (c) timeout propagation, (d) error surfacing when the bridge throws, (e) `spawnParallel()` invokes the bridge concurrently for an N-call batch.
- [ ] #3 `SpawnerKind` in `pipeline-cli/src/cli/execute.ts` includes `'copilot'`; `SPAWNER_KINDS` array updated; existing `default:` exhaustiveness check still compiles.
- [ ] #4 `resolveSpawner('copilot')` constructs a `CopilotHarnessAdapter` wired to a default subprocess bridge. When neither `copilot` is on PATH nor `$COPILOT_SPAWN_AGENT_BIN` is set, throws a clear error message that names the env var AND the install hint — before any pipeline mutation. Hermetic test covers the throw path.
- [ ] #5 New code reaches 80%+ patch coverage (enforced by `scripts/check-coverage.sh`).
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean before push.
<!-- AC:END -->
