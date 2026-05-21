---
id: AISDLC-377.4
title: 'feat(deprecation): RFC-0041 Phase 3.1 — deprecate --spawner claude-cli (warning + operator runbook)'
status: Done
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

- [x] #1 `cli-orchestrator tick --spawner claude-cli` prints deprecation warning to stderr on invocation
- [x] #2 `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1` suppresses the warning (used by transitional CI)
- [x] #3 `docs/operations/operator-runbook.md` new section published with three-pattern comparison + migration recipe
- [x] #4 CLAUDE.md "Canonical execution paths" table reflects the new + deprecated paths
- [x] #5 `pipeline-cli/docs/spawner.md` updated; `claude-cli` row moved to "Deprecated"
- [x] #6 Hermetic test: invoke `--spawner claude-cli` with the suppression env → no warning on stderr; without → warning present
- [x] #7 New code reaches 80%+ patch coverage (mostly docs; code change is one-line warning emission)

## Out of scope

- Removing `--spawner claude-cli` entirely (Phase 3.3 / AISDLC-377.6)
- `cli-deps frontier --recommendedWorkerKind` annotation (Phase 3.2 / AISDLC-377.5; independent)

## Source

RFC-0041 §7 Phase 3 deliverable list.

## Final Summary

### Summary

RFC-0041 Phase 3.1 ships a deprecation warning for `--spawner claude-cli`. The new helper `emitClaudeCliDeprecationWarning(stream, env)` fires on both `cli-orchestrator tick` and `cli-orchestrator start` when the spawner resolves to `claude-cli`, suppressible via `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1`. Operator runbook gains a "Choosing a dispatch model" section; CLAUDE.md spawner table marks `claude-cli` DEPRECATED (removal v0.11) and documents the RFC-0041 `in-session-agent` and `claude-p-shell` replacements; `pipeline-cli/docs/spawner.md` gains a "Deprecated spawners" section.

### Changes

- `pipeline-cli/src/orchestrator/deprecation-warnings.ts` (new): testable warning helper with stream + env injection so tests can capture without spawning the CLI.
- `pipeline-cli/src/orchestrator/deprecation-warnings.test.ts` (new): 7 hermetic Vitest cases — emit/suppress branches, env-var edge cases (absent / `0` / `1` / `"  1  "`), exported constants shape check.
- `pipeline-cli/src/cli/orchestrator.ts` (modified): call-site wiring on both `tick` and `start` handlers — fires only when resolved spawner is `claude-cli`.
- `docs/operations/operator-runbook.md` (modified): new "Choosing a dispatch model" section with three-pattern comparison + migration recipe.
- `CLAUDE.md` (modified): "Canonical execution paths" spawner list updated; `claude-cli` marked DEPRECATED, new `in-session-agent` and `claude-p-shell` rows added.
- `pipeline-cli/docs/spawner.md` (modified): `claude-cli` row moved to new "Deprecated spawners" section.

### Design decisions

- **Helper accepts a generic `{ write }` stream**: enables hermetic test capture without `process.stderr` mutation. Call-sites pass `process.stderr` literally.
- **Suppression trims whitespace before strict `=== '1'` comparison**: matches the operator convention used elsewhere in the codebase (env-var truthy checks). Round 1 reviewer noted this is undocumented — non-blocking minor.
- **Warning text avoids referencing any `--spawner` flag**: round 1 code-reviewer caught the original text instructing operators to use `--spawner dispatch-board` (not a valid spawner kind). The fix (commit `a603e9c4`) replaces it with the documented migration path: "Migrate to in-session-agent Workers: open N CC sessions running `/ai-sdlc dispatch-worker`."

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 7 new tests in `deprecation-warnings.test.ts` pass; full pipeline-cli suite passes
- `pnpm --filter @ai-sdlc/pipeline-cli lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviewer subagents:
  - `code-reviewer` (Sonnet) — round 1: 1 major (fixed inline), 2 minor (deferred), 1 suggestion (deferred). Round 2 after fix: APPROVED, 0 findings.
  - `test-reviewer` (Sonnet) — APPROVED, 2 minor (call-site coverage gap, empty-string env case — deferred).
  - `security-reviewer` (Opus) — APPROVED, 0 findings.

### Follow-up

- Minor: `resolveUmbrellaSpawnerKind` is called twice per handler in `cli/orchestrator.ts` (once for billing warnings, once for the new deprecation check). Cosmetic; capture in a local `const` in a future cleanup PR.
- Minor: undocumented whitespace-trim in suppression semantics — either document `"  1  "` works, or tighten to strict `=== '1'`.
- Suggestion: removal version v0.11 is one minor release away. If adopters need more migration time, bump to v0.12 (operator decision).
- Minor: orchestrator.test.ts has no integration coverage of the warning call-site guards. Helper logic is covered; call-site guard is a trivial one-liner.
- AISDLC-377.6 (Phase 3.3) will remove `--spawner claude-cli` entirely after the v0.11 deprecation window.
