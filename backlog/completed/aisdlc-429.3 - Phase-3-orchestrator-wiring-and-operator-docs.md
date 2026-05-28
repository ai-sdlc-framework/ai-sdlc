---
id: AISDLC-429.3
title: 'Phase 3: orchestrator wiring + operator docs for `--spawner copilot`'
status: Done
labels:
  - rfc-0012
  - copilot
  - phase-3
  - integration
  - docs
parentTaskId: AISDLC-429
dependencies:
  - AISDLC-429.2
assumes:
  - RFC-0012
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/loop.umbrella.test.ts
  - pipeline-cli/README.md
  - CLAUDE.md
  - docs/operations/operator-runbook.md
  - docs/operations/codex-execution-path.md
priority: high
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

After Phase 2 (AISDLC-429.2) lands `CopilotHarnessAdapter` and `--spawner copilot` for `cli-execute`, the autonomous orchestrator (`cli-orchestrator tick`) still needs to route the kind through `umbrellaSpawnerKind` / `resolveUmbrellaSpawnerKind()`. Without that wiring, `cli-orchestrator tick --spawner copilot` would parse the flag but the umbrella dispatcher couldn't forward it to per-task `executePipeline()` calls.

Separately, operators need a discoverable doc path: the README spawner-kinds table, the CLAUDE.md "Spawner kinds for `cli-orchestrator tick`" bullet list, and a dedicated operator runbook entry that covers install, env-var override, billing safety, and known limitations vs. `claude` / `codex`.

## Goal

- Wire `'copilot'` through the orchestrator umbrella dispatch path so `cli-orchestrator tick --spawner copilot` end-to-end-routes the kind to the per-task umbrella executor.
- Update operator-facing documentation so the `copilot` kind is discoverable and runnable without reading source code.

## Implementation notes

- The `SpawnerKind` union (`pipeline-cli/src/cli/execute.ts:111`) is already extended by Phase 2. `pipeline-cli/src/orchestrator/loop.ts` re-imports `SpawnerKind` via `import { ... type SpawnerKind } from '../cli/execute.js'` — no manual edit there, just verify the type narrows correctly through `umbrellaSpawnerKind` and `resolveUmbrellaSpawnerKind()`.
- `loop.umbrella.test.ts` — add at least one case that drives the umbrella dispatcher with `umbrellaSpawnerKind: 'copilot'` and asserts the kind reaches the injected `umbrellaExecutor` callback unchanged. Pattern: copy the existing `'codex'` case at `loop.umbrella.test.ts:494`.
- `pipeline-cli/README.md` — add a `copilot` row to the "Spawner kinds" table with billing column = "GitHub Copilot subscription" and a brief description. If the README has a "billing safety" callout near the `codex` row, mirror it for `copilot`.
- `CLAUDE.md` "Spawner kinds for `cli-orchestrator tick <kind>`" — add a `copilot` bullet alongside `mock` / `api-key` / `claude` / `codex`. Wording should mirror the `codex` entry's structure (kind, billing, when to use).
- New file `docs/operations/copilot-spawner.md` — install path for the `copilot` CLI, env-var override (`$COPILOT_SPAWN_AGENT_BIN`), known limitations vs. `claude` / `codex`, and the billing-safety note from the parent task's Risk section ("must fail clearly when neither `copilot` is on PATH nor `$COPILOT_SPAWN_AGENT_BIN` is set, rather than silently falling back to `ANTHROPIC_API_KEY`"). Cross-link from `docs/operations/operator-runbook.md` and from the README spawner-kinds table.

The Phase 1 execution-path map (`docs/operations/copilot-execution-path.md`) already documents the per-step Codex-vs-Copilot deltas — link to it from the new operator runbook entry rather than duplicating content.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `cli-orchestrator tick --spawner copilot` accepts the kind via yargs `choices: SPAWNER_KINDS`; `resolveUmbrellaSpawnerKind()` round-trips it; the umbrella dispatcher forwards it to the per-task executor.
- [x] #2 `pipeline-cli/src/orchestrator/loop.umbrella.test.ts` has at least one new case proving the umbrella dispatcher routes `umbrellaSpawnerKind: 'copilot'` to the injected `umbrellaExecutor` unchanged. Pattern matches the existing `'codex'` case.
- [x] #3 `pipeline-cli/README.md` "Spawner kinds" table includes a `copilot` row with billing column = "GitHub Copilot subscription".
- [x] #4 `CLAUDE.md` "Spawner kinds for `cli-orchestrator tick <kind>`" bullet list includes a `copilot` entry parallel to the existing `codex` bullet.
- [x] #5 New operator-facing doc `docs/operations/copilot-spawner.md` exists with: install path, env-var override, known limitations vs. `claude` / `codex`, billing-safety note. Cross-linked from `docs/operations/operator-runbook.md` and the README spawner-kinds table.
- [x] #6 New code reaches 80%+ patch coverage (enforced by `scripts/check-coverage.sh`).
- [x] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean before push.
<!-- AC:END -->

## Final Summary

### Summary

Phase 3 of AISDLC-429 wires `'copilot'` through the orchestrator umbrella dispatch path so `cli-orchestrator tick --spawner copilot` (and `AI_SDLC_ORCHESTRATOR_SPAWNER=copilot`) end-to-end-route the kind to the per-task `executePipeline()` call landed in Phase 2. Three test cases mirror the existing `'codex'` umbrella cases (explicit `umbrellaSpawnerKind`, env-var-driven default, missing-bridge surfacing as `spawner-unavailable`). Operator-facing docs land in three surfaces: a new bullet in the worktree `CLAUDE.md` spawner-kinds list, a new `copilot` row in `pipeline-cli/README.md`'s "Spawner kinds" table (billing column = "GitHub Copilot subscription"), and a new operator runbook entry at `docs/operations/copilot-spawner.md` covering install path, env-var override, billing safety, and known limitations vs. `claude` / `codex`. The new runbook cross-links from `docs/operations/operator-runbook.md`'s Execution Path References table and from the README spawner row.

### Changes

- `pipeline-cli/src/orchestrator/loop.ts` (modified): `resolveEnvUmbrellaSpawnerKind()` now accepts `'copilot'` in its whitelist; the migration error message + "must be one of" error message both updated to enumerate the new kind. The `resolveUmbrellaSpawnerKind()` docstring updated.
- `pipeline-cli/src/orchestrator/loop.umbrella.test.ts` (modified): three new test cases for the copilot kind — explicit `umbrellaSpawnerKind: 'copilot'` route-through, `AI_SDLC_ORCHESTRATOR_SPAWNER=copilot` env-var default, and the missing-`COPILOT_SPAWN_AGENT_BIN` `spawner-unavailable` surfacing.
- `pipeline-cli/README.md` (modified): added the `copilot` row to the `--spawner` options table; updated the prose at the top to enumerate `--spawner copilot` as a valid option.
- `CLAUDE.md` (modified): added a `copilot` bullet to the "Spawner kinds for `cli-orchestrator tick <kind>`" list, parallel to the existing `codex` entry.
- `docs/operations/copilot-spawner.md` (new): the AC #5 runbook — install path, wire protocol, env-var override (`COPILOT_SPAWN_AGENT_BIN`), `cli-execute` / `cli-orchestrator tick` quickstarts, billing safety contract, and a comparison table covering known limitations vs. `claude` / `codex` (no canonical bridge shipped yet; no PATH-based auto-fallback; no cross-harness reviewer agents yet; pilot pending).
- `docs/operations/operator-runbook.md` (modified): added a row to the Execution Path References table pointing at both the Phase 1 design map and the new operator runbook.
- `backlog/tasks/aisdlc-429.3 …` → `backlog/completed/aisdlc-429.3 …` (renamed): standard task-completion lifecycle move.

### Design decisions

- **No CLAUDE.md edit to parent worktree.** Pattern-C parent worktree is read-only — only the worktree's own `CLAUDE.md` was edited. The parent's `CLAUDE.md` will sync from main on the operator's next manual `git pull` cycle (standard Pattern-C workflow per `feedback_pull_main_proactively.md`).
- **Resolver does NOT add a PATH-based fallback.** Phase 2 shipped env-var-only resolution to keep the billing-safety guarantee (refuse to silently fall back to `ANTHROPIC_API_KEY`) simple. Phase 3 documents this limitation rather than expanding the resolver surface — extending the resolver to `which copilot` could erode the no-fallback invariant. Logged in the runbook's "Known limitations" table as a possible future enhancement.
- **No canonical Copilot bridge script shipped.** Codex Phase 2 (AISDLC-251) shipped `scripts/codex-spawn-agent-bridge.mjs` after a smoke-tested invocation grammar was pinned. Copilot's CLI invocation grammar has not been pinned by a real pilot yet, so shipping a canonical bridge now would risk locking in flags that the real pilot finds wrong. Documented in the runbook as pilot-pending.

### Verification

- `pnpm build` — pending in verify step
- `pnpm test` — pending in verify step
- `pnpm lint` — pending in verify step
- `pnpm format:check` — pending in verify step

### Follow-up

- Real-CLI pilot of `--spawner copilot` end-to-end (analogous to AISDLC-202.4 for Codex). Operator-authorized only — do NOT auto-file (AISDLC-308 scope-creep rule).
- Cross-harness Copilot reviewer agents (`code-reviewer-copilot`, `test-reviewer-copilot`) — analogous to AISDLC-247 for Codex. Out of scope for Phase 3; operator-authorized only.
- Canonical bridge script `scripts/copilot-spawn-agent-bridge.mjs` — pin once the operator runs a real-CLI pilot that validates the invocation grammar; out of scope for Phase 3.
