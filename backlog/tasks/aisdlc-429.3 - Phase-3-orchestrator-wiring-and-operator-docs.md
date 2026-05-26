---
id: AISDLC-429.3
title: 'Phase 3: orchestrator wiring + operator docs for `--spawner copilot`'
status: To Do
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
- [ ] #1 `cli-orchestrator tick --spawner copilot` accepts the kind via yargs `choices: SPAWNER_KINDS`; `resolveUmbrellaSpawnerKind()` round-trips it; the umbrella dispatcher forwards it to the per-task executor.
- [ ] #2 `pipeline-cli/src/orchestrator/loop.umbrella.test.ts` has at least one new case proving the umbrella dispatcher routes `umbrellaSpawnerKind: 'copilot'` to the injected `umbrellaExecutor` unchanged. Pattern matches the existing `'codex'` case.
- [ ] #3 `pipeline-cli/README.md` "Spawner kinds" table includes a `copilot` row with billing column = "GitHub Copilot subscription".
- [ ] #4 `CLAUDE.md` "Spawner kinds for `cli-orchestrator tick <kind>`" bullet list includes a `copilot` entry parallel to the existing `codex` bullet.
- [ ] #5 New operator-facing doc `docs/operations/copilot-spawner.md` exists with: install path, env-var override, known limitations vs. `claude` / `codex`, billing-safety note. Cross-linked from `docs/operations/operator-runbook.md` and the README spawner-kinds table.
- [ ] #6 New code reaches 80%+ patch coverage (enforced by `scripts/check-coverage.sh`).
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean before push.
<!-- AC:END -->
