---
id: AISDLC-202.2
title: 'Phase 2: Codex adapter for developer and reviewer dispatch plus Step 2 slug fallback'
status: Done
assignee: []
created_date: '2026-05-05 20:15'
updated_date: '2026-05-07 18:30'
labels:
  - rfc-0012
  - codex
  - phase-2
  - implementation
  - pipeline-cli
parentTaskId: AISDLC-202
dependencies:
  - AISDLC-202.1
references:
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/steps/02-compute-branch.ts
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Per the AISDLC-202.1 design map, Codex CLI cannot dispatch plugin agents via Claude Code's `Agent` tool. The AISDLC-201 run hand-rolled the dispatch using Codex `spawn_agent`. This needs to become a reusable adapter that other Codex-driven runs can call without re-deriving the contract each time.

Additionally, the AISDLC-201 run hit a Step 2 branch slug fallback bug — the fallback path produced a malformed branch name that had to be hand-patched. That bug needs a real fix in the deterministic step.

## Goal

Ship a `CodexHarnessAdapter` (or equivalent abstraction) that:
- Wraps Codex `spawn_agent` for developer + 3 reviewer dispatch
- Returns `DeveloperReturn` and reviewer verdict JSON in the schema the rest of the pipeline expects (no manual JSON reshaping needed)
- Is selectable via the existing `--spawner` CLI flag (e.g., `--spawner codex`) or via env detection

Also fix the Step 2 branch slug fallback so it produces valid branch names without manual intervention.

## Implementation notes

The adapter should live alongside the existing spawners in `pipeline-cli/src/spawners/` (or wherever the codex spawner ends up being conventionally placed). Tests should mock Codex's `spawn_agent` interface so the adapter contract is verifiable without a real Codex CLI install.

The Step 2 fix is a separable commit — could ship in a precursor PR.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `CodexHarnessAdapter` (or equivalent) implements developer + 3-reviewer dispatch via Codex `spawn_agent` with the same return-value contract as the Claude Code Agent path.
- [x] #2 Reviewer verdict JSON returned by the adapter passes through Step 8 aggregation without manual reshaping.
- [x] #3 The adapter is selectable via `--spawner codex` (or equivalent operator-facing knob) and documented in `pipeline-cli/README.md`.
- [x] #4 Unit tests mock Codex `spawn_agent` and prove the adapter contract — no real Codex CLI required to run the test suite.
- [x] #5 Step 2 branch slug fallback bug is fixed so degraded inputs produce a valid branch name without operator intervention; regression test added.
- [x] #6 New code reaches 80%+ patch coverage.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 2 of the Codex execution path: shipped a callback-driven `CodexHarnessAdapter` over Codex `spawn_agent`, wired `--spawner codex` into `ai-sdlc-pipeline execute`, and replaced the AISDLC-180 fail-loud branch on degraded slug inputs with a stable fallback so unattended Codex runs no longer require operator hand-patching of branch names.

## Changes
- `pipeline-cli/src/runtime/spawners/codex-harness.ts` (new): `CodexHarnessAdapter` (`SubagentSpawner` over an injected `CodexSpawnAgentFn`), per-`SubagentType` `DEFAULT_SYSTEM_PROMPTS`, reviewer-verdict normalisation that stamps `harness: 'codex'`, lenient JSON-with-fences parsing, and `subprocessCodexSpawnAgent()` — a JSON-line bridge factory the CLI uses when `CODEX_SPAWN_AGENT_BIN` is set.
- `pipeline-cli/src/runtime/spawners/codex-harness.test.ts` (new): 30 tests against an in-memory `spawnAgent` mock and a fake `child_process.spawn` — no Codex CLI required. Covers developer + reviewer dispatch contracts, parallel reviewer fan-out, end-to-end Step 8 aggregation, subprocess bridge protocol, and timeout behaviour.
- `pipeline-cli/src/runtime/index.ts` (modified): re-exports the codex spawner so `@ai-sdlc/pipeline-cli` consumers can import directly.
- `pipeline-cli/src/cli/execute.ts` (modified): adds `'codex'` to `SpawnerKind`/`SPAWNER_KINDS`, wires `resolveSpawner('codex')` to `new CodexHarnessAdapter({ spawnAgent: subprocessCodexSpawnAgent() })`, expands the docstring, and updates the yargs `--spawner` description.
- `pipeline-cli/src/cli/execute.test.ts` (modified): adds resolver tests for `--spawner codex` (env-unset error path + env-set construction path).
- `pipeline-cli/src/steps/02-compute-branch.ts` (modified): replaces the AISDLC-180 throw with a stable `FALLBACK_SLUG = 'task'` substitution, logs a `PipelineLogger.warn` so the upstream parser bug is still grep-able, and adds an optional `logger` option for tests.
- `pipeline-cli/src/steps/02-compute-branch.test.ts` (modified): drops the throw assertion, adds 6 regression tests covering block-scalar markers, pure-punctuation titles, em-dash-only titles (the AISDLC-201 reproducer shape), and the no-`{slug}`-pattern path.
- `pipeline-cli/README.md` (modified): updates the `--spawner` table (`claude-cli` → shipped, `codex` → shipped via AISDLC-202.2), adds a Codex section with the JSON-line bridge protocol and programmatic-construction example.
- `backlog/tasks/aisdlc-202.2 - …` (modified → moved to `backlog/completed/`): status flip + ACs + this final summary.

## Design decisions
- **Callback-driven adapter, not a Codex CLI subprocess wrapper.** The adapter takes a `CodexSpawnAgentFn` injection so `pipeline-cli` stays free of Codex CLI version coupling. Tests pass deterministic mocks; production wires a host bridge. The CLI flag's default subprocess bridge implements a minimal JSON-line protocol so any host language can implement it.
- **`harness: 'codex'` stamped server-side.** The adapter normalises reviewer envelopes before returning, so even if a Codex agent forgets the harness field the verdict aggregator still attributes correctly. This was one of the reshape steps AISDLC-201 had to do by hand.
- **`FALLBACK_SLUG = 'task'` over a hash or the task ID.** Picked for: stability across retries (same task → same branch), grep-ability for operators investigating degraded titles, and brevity. The warn-log preserves the AISDLC-180 diagnostic so the upstream parser bug doesn't disappear silently.
- **`CODEX_SPAWN_AGENT_BIN` env over a hard-coded `codex exec` shell-out.** Keeps `pipeline-cli` honest about the bridge requirement (the design map flagged that non-interactive Codex output reliability is unproven) and gives operators a clear configuration surface.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 2365 passed (149 files)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Patch coverage: `codex-harness.ts` 90.35% lines / 81.08% branches / 100% functions; `02-compute-branch.ts` 95.12% lines / 92.3% branches / 100% functions — both well above the 80% gate.

## Follow-up
- AISDLC-202.3 (gated on AISDLC-203): record `harness: { name, version }` on the DSSE envelope and route Codex finalisation through MCP `task_complete`.
- AISDLC-202.4: end-to-end verification + dogfood pilot using the bridge.
<!-- SECTION:FINAL_SUMMARY:END -->
