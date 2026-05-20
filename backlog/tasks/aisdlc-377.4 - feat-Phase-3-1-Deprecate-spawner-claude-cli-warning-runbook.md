---
id: AISDLC-377.4
title: 'feat(deprecation): RFC-0041 Phase 3.1 — deprecate --spawner claude-cli (warning + operator runbook)'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0041
  - phase-3
  - deprecation
  - operator-runbook
parentTaskId: AISDLC-377
dependencies:
  - AISDLC-377.3
priority: medium
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - pipeline-cli/docs/spawner.md
  - docs/operations/operator-runbook.md
---

## Scope (RFC-0041 §7 Phase 3.1)

Adds a deprecation warning to the legacy `--spawner claude-cli` path (the in-CC `Agent(... run_in_background)` dispatcher that races the Anthropic 600s watchdog) and points operators at the Dispatch Board model. Does NOT remove the path — that's Phase 3.3 (AISDLC-377.6), after one release window.

### Deliverables

1. **Deprecation warning in `cli-orchestrator tick --spawner claude-cli`**:
   - On invocation, print: `[deprecated] --spawner claude-cli will be removed in v0.X. Use --spawner dispatch-board with N operator-opened CC sessions running /ai-sdlc dispatch-worker. See docs/operations/dispatch-supervisor-install.md for migration guide.`
   - Suppressible via `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1` for ops who can't migrate this release

2. **Operator runbook section** (`docs/operations/operator-runbook.md`):
   - New section: "Choosing a dispatch model" with side-by-side comparison of the three patterns:
     - **In-session-agent** (N CC terminals + dispatch board) — subscription-only, recommended default
     - **Claude-p-shell** (supervisor daemon) — Agent SDK credit pool, for headless
     - **Legacy `--spawner claude-cli`** — DEPRECATED, will be removed
   - Migration recipe: "If you currently run `/ai-sdlc orchestrator-tick` and rely on `Agent(... run_in_background)`, you need to switch to `dispatch-worker` sessions before v0.X"

3. **CLAUDE.md "Canonical execution paths" table update**:
   - Mark `claude-cli` spawner row as `DEPRECATED`
   - Add 2 new rows for `in-session-agent` and `claude-p-shell` patterns
   - Note removal version

4. **`pipeline-cli/docs/spawner.md` update**:
   - Move `claude-cli` to "Deprecated" section
   - Cross-link new dispatch-board docs

## Acceptance criteria

- [ ] #1 `cli-orchestrator tick --spawner claude-cli` prints deprecation warning to stderr on invocation
- [ ] #2 `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1` suppresses the warning (used by transitional CI)
- [ ] #3 `docs/operations/operator-runbook.md` new section published with three-pattern comparison + migration recipe
- [ ] #4 CLAUDE.md "Canonical execution paths" table reflects the new + deprecated paths
- [ ] #5 `pipeline-cli/docs/spawner.md` updated; `claude-cli` row moved to "Deprecated"
- [ ] #6 Hermetic test: invoke `--spawner claude-cli` with the suppression env → no warning on stderr; without → warning present
- [ ] #7 New code reaches 80%+ patch coverage (mostly docs; code change is one-line warning emission)

## Out of scope

- Removing `--spawner claude-cli` entirely (Phase 3.3 / AISDLC-377.6)
- `cli-deps frontier --recommendedWorkerKind` annotation (Phase 3.2 / AISDLC-377.5; independent)

## Source

RFC-0041 §7 Phase 3 deliverable list.
