---
id: AISDLC-429
title: 'feat(pipeline-cli): add `copilot` spawner kind — GitHub Copilot CLI as a coding harness alongside `claude` / `codex` / `api-key`'
status: To Do
labels:
  - enhancement
  - pipeline-cli
  - rfc-0012
  - copilot
  - spawner
  - parent
  - developer-experience
dependencies: []
assumes:
  - RFC-0012
references:
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/runtime/spawners/codex-harness.ts
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - pipeline-cli/src/runtime/default-spawner.ts
  - pipeline-cli/src/runtime/subagent-spawner.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/README.md
priority: medium
permittedExternalPaths: []
blocked:
  reason: 'Umbrella parent task — dispatch sub-phases AISDLC-429.1, AISDLC-429.2, AISDLC-429.3 directly. 429.1 (design map, paper-only) unblocks 429.2 (adapter + resolver); 429.2 unblocks 429.3 (orchestrator wiring + docs). Parent unblocks when all three sub-tasks reach Done.'
  unblockedBy:
    - AISDLC-429.1
    - AISDLC-429.2
    - AISDLC-429.3
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`pipeline-cli` currently accepts four `--spawner` kinds — `mock`, `api-key`, `claude` (default), and `codex` (see `SpawnerKind` in `pipeline-cli/src/cli/execute.ts:111`). Operators who pay for **GitHub Copilot** (Business / Enterprise / Pro+) have a coding-grade CLI of their own (`copilot` — the standalone GitHub Copilot CLI, distinct from `gh copilot`) that can drive a multi-step developer + reviewer loop. There is no first-class way to dispatch the AI-SDLC pipeline via that harness today; an operator on Copilot has to either bring an `ANTHROPIC_API_KEY` (paid API tokens) or spin up Claude Code separately to run `/ai-sdlc execute`.

This is a parity gap with the `codex` work (AISDLC-202): once Codex CLI was added as a `SubagentSpawner`, Codex operators got the full Step 0-13 pipeline at subscription billing. Copilot users deserve the same path.

## Goal

Add `copilot` to `SpawnerKind`, ship a `CopilotHarnessAdapter` that implements `SubagentSpawner` by bridging to GitHub Copilot CLI's coding-agent invocation, and make `--spawner copilot` selectable from both `cli-execute` and `cli-orchestrator tick`. Mirror the AISDLC-202.2 (`CodexHarnessAdapter`) architecture: a callback-driven adapter that is host-agnostic, plus a default subprocess bridge that shells out to `$COPILOT_SPAWN_AGENT_BIN` (or the `copilot` CLI directly when available on `PATH`).

## Non-goals

- Promoting `copilot` to the auto-detected default in `defaultSpawner()` — explicit opt-in only via `--spawner copilot` for the initial cut.
- Building Copilot-specific RFC tooling, billing telemetry, or Copilot-side MCP servers. Treat Copilot CLI as a generic agent dispatcher: the adapter sends a system prompt + user prompt, gets back text + optional pre-parsed JSON, normalises to `SubagentResult`.
- Cross-harness review integration — Copilot-spawned dispatches use the same 3-reviewer fan-out as the other spawners. A future task can extend cross-harness review across `claude` / `codex` / `copilot`.
- Conductor/Worker (RFC-0041) Worker support. The initial cut only wires the `executePipeline()` path; Worker sessions stay Claude-Code-only until a follow-up task evaluates how a Copilot Worker would claim from the Dispatch Board.

## Composes with

- **RFC-0012 §8 (SubagentSpawner)** — the spawner contract this implements.
- **AISDLC-202.2 (`CodexHarnessAdapter`)** — the architectural template. The new code lives next to `codex-harness.ts` (and `codex-harness.test.ts`) under `pipeline-cli/src/runtime/spawners/copilot-harness.{ts,test.ts}`.
- **`cli-orchestrator tick --spawner` plumbing** — `SpawnerKind` is referenced in `pipeline-cli/src/orchestrator/loop.ts` (`umbrellaSpawnerKind`, `resolveUmbrellaSpawnerKind`). Both files need the new union member.
- **`pipeline-cli/README.md`** — the "Spawner kinds" table needs a `copilot` row. `CLAUDE.md` already documents `mock` / `api-key` / `claude` / `codex` under "Spawner kinds for `cli-orchestrator tick --spawner <kind>`" — that table also needs a row.

## Risk

- **Copilot CLI surface stability**: the standalone `copilot` CLI is comparatively new (GA 2025). The adapter must isolate the wire format behind `CopilotSpawnAgentFn` (callback boundary), mirroring how `CodexHarnessAdapter` isolates Codex's `spawn_agent`. If the CLI's invocation grammar changes, only the subprocess bridge changes — the adapter contract is stable.
- **Hermetic tests**: tests MUST mock `CopilotSpawnAgentFn` and never touch a real `copilot` binary, so `pnpm test` runs everywhere (matching AISDLC-202.2 AC #4).
- **Billing safety**: Copilot CLI bills against the operator's GitHub Copilot subscription. The CLI parse path MUST fail clearly when neither `copilot` is on PATH nor `$COPILOT_SPAWN_AGENT_BIN` is set, rather than silently falling back to `ANTHROPIC_API_KEY` (mirrors the `codex` resolver's "configure CODEX_SPAWN_AGENT_BIN" message). Add this to the operator-runbook entry.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 All three sub-tasks (AISDLC-429.1, AISDLC-429.2, AISDLC-429.3) reach Done status.
- [ ] #2 `pnpm --filter @ai-sdlc/pipeline-cli exec` exposes `--spawner copilot` end-to-end through `cli-execute` and `cli-orchestrator tick`, with the same operator-facing wiring the existing `claude` / `codex` / `api-key` kinds have.
- [ ] #3 Operator-facing documentation (`pipeline-cli/README.md` spawner-kinds table + `CLAUDE.md` "Spawner kinds" list + `docs/operations/copilot-spawner.md` runbook + cross-link from the operator runbook) is up to date and reviewable as the canonical source for picking the `copilot` kind.

<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
**Adapter layout.** Copy the structural pattern from `pipeline-cli/src/runtime/spawners/codex-harness.ts`:

- `CopilotSpawnAgentRequest` / `CopilotSpawnAgentResponse` / `CopilotSpawnAgentFn` — the narrow boundary the host bridge implements.
- `CopilotHarnessAdapter implements SubagentSpawner` with `spawn()` and `spawnParallel()`.
- Per-`SubagentType` default system prompts (minimal "behave like the ai-sdlc <type>" strings); operators can override via `systemPrompts` constructor option to inject the full plugin-agent bodies.
- Response normalisation: developer → `DeveloperReturn`, reviewers → `{approved, findings, summary, harness:'copilot'}`.

**Subprocess bridge.** The default `subprocessCopilotSpawnAgent()` should:

1. Prefer `$COPILOT_SPAWN_AGENT_BIN` when set (matches Codex's `$CODEX_SPAWN_AGENT_BIN` ergonomics — lets operators wrap the CLI in their own auth/transport).
2. Otherwise resolve `copilot` on `PATH` and shell out. The exact invocation grammar is captured as part of the implementation discovery (see "Phase suggestion" below); document the chosen grammar in the operator runbook (AC #7) and keep the adapter contract stable across grammar revisions by funnelling all wire-format concerns through the bridge.
3. Use `child_process.spawn` (not `execFile`) so we can stream stdout/stderr without buffering the full transcript in memory.
4. Honour the per-call `timeoutMs` from the request.

**Slug fallback.** Step 2's `computeBranchSlug` (`pipeline-cli/src/steps/02-compute-branch.ts`) already has the AISDLC-202.2 fix in it — no Copilot-specific change needed.

**Phase suggestion (operator may split).** If the wire-format research for the `copilot` CLI invocation surfaces material gaps, prefer splitting along the AISDLC-202 precedent into three sub-tasks created via `task_create` BEFORE dispatching implementation:

- Phase 1 sub-task: Document the Copilot execution path + invocation grammar gaps (no code).
- Phase 2 sub-task: `CopilotHarnessAdapter` + `--spawner copilot` resolver (bulk of the work; covers AC #1 through #4 plus #8 and #9).
- Phase 3 sub-task: Orchestrator wiring + docs + runbook (covers AC #5 through #7).

A single PR is acceptable if the wire format is stable and the diff stays reviewable; otherwise file the phase sub-tasks (per the "Create-before-execution" rule in CLAUDE.md) before dispatching implementation.

**Out-of-scope reminder.** Do NOT resolve any RFC Open Questions inline. If the implementation surfaces a question that touches RFC-0012's `SubagentSpawner` contract semantics, escalate per CLAUDE.md "Subagent Governance — OQ-resolution prohibition (AISDLC-298)" — return `prUrl: null` with a notes field and stop.
<!-- SECTION:NOTES:END -->
