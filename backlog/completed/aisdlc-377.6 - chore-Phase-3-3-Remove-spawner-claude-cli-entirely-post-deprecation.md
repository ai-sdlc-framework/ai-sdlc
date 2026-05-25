---
id: AISDLC-377.6
title: 'chore(deprecation): RFC-0041 Phase 3.3 — remove --spawner claude-cli entirely (post-deprecation window)'
status: Done
assignee: []
created_date: '2026-05-20'
completed_date: '2026-05-25'
labels:
  - rfc-0041
  - phase-3
  - breaking-change
  - removal
parentTaskId: AISDLC-377
dependencies:
  - AISDLC-377.4
priority: low
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - docs/operations/claude-cli-spawner-removed.md
---

## Scope (RFC-0041 §7 Phase 3.3)

Removes the legacy `--spawner claude-cli` path entirely. This is a **breaking change** for any operator who has not migrated to the dispatch-board model.

**Hard prerequisite**: AISDLC-377.4 has been on a released main for at least one full release window (one release = ~1–2 weeks typical cadence). Operator unblocks this task when the window has elapsed AND they have verified no internal callers remain.

### Deliverables

1. **Remove the spawner kind handling** from the cli-orchestrator source under pipeline-cli/src/cli/:
   - Delete the spawner kind from the CLI's argument parser
   - Delete the claude-cli inline spawner module under pipeline-cli/src/runtime/spawners/ (path: claude-cli-inline.ts in current repo layout)
   - Delete its co-located test file

2. **Update CLAUDE.md** to remove the deprecated row entirely from the spawner kinds table

3. **Update the pipeline-cli spawner docs** (under pipeline-cli/docs/) to remove the Deprecated section

4. **Operator migration breadcrumb**: ship a brief migration doc under docs/operations/ for one more release in case anyone still has the deprecated form in a script

## Acceptance criteria

- [x] #1 claude-cli spawner code + tests removed from pipeline-cli
- [x] #2 cli-orchestrator tick --spawner claude-cli now errors with an Unknown-spawner-kind message pointing at the new migration doc
- [x] #3 CLAUDE.md + pipeline-cli docs no longer reference claude-cli (except in the migration breadcrumb)
- [x] #4 The new docs/operations/ migration breadcrumb exists with the recommended replacement paths
- [ ] #5 No Agent(... run_in_background: true) calls remain in the dispatch hot path (grep test in CI) — **REINTERPRETED**: scoped to the legacy claude-cli dispatch hot path only. Pattern X v2 (AISDLC-396) deliberately uses `run_in_background:true` in `/ai-sdlc orchestrator-tick` Step 2.5 Phase B as its core dev-dispatch mechanism (the operator-typed dispatch board cannot register completion callbacks any other way). Adding a literal grep test would break that documented design. See migration-breadcrumb "Implementation note — AC #5" section for the full reasoning. Operator sign-off via this PR.
- [x] #6 New code reaches 80%+ patch coverage (mostly removal — coverage drops are expected and gate-allowed)

## Out of scope

- Removing `/ai-sdlc execute` (single-task interactive path stays; orthogonal to dispatch-board)
- Migrating downstream adopters' scripts (we publish the breadcrumb; adopters do their own migration)

## Source

RFC-0041 §7 Phase 3.3 deliverable; gated by operator-declared deprecation window per AISDLC-377.4.

## Final summary

Removed the `--spawner claude-cli` inline-manifest spawner (`ClaudeCliInlineSpawner`, AISDLC-198) entirely after the AISDLC-377.4 deprecation window elapsed. The yargs `--spawner` choices list no longer includes `claude-cli`; programmatic callers passing the string literal receive `CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE` pointing at the migration breadcrumb. `AI_SDLC_ORCHESTRATOR_SPAWNER=claude-cli` env-var paths also fail with the same migration message. The fallback-retry guard for the "manifest-not-consumed" failure mode was dropped (claude-cli was the only kind that ever matched it). Test coverage retained — the AISDLC-377.4 deprecation-warning tests were deleted along with `deprecation-warnings.ts`; the umbrella loop tests now assert the no-retry contract post-removal. New migration breadcrumb at `docs/operations/claude-cli-spawner-removed.md`.

### Changes

- `pipeline-cli/src/runtime/spawners/claude-cli-inline.{ts,test.ts}` (deleted)
- `pipeline-cli/src/orchestrator/deprecation-warnings.{ts,test.ts}` (deleted)
- `docs/operations/claude-cli-spawner.md` (deleted)
- `docs/operations/orchestrator-inline-loop.md` (deleted)
- `docs/operations/claude-cli-spawner-removed.md` (new — migration breadcrumb)
- `pipeline-cli/src/cli/execute.ts`: removed `'claude-cli'` from `SpawnerKind` union + `SPAWNER_KINDS`; replaced `CLAUDE_CLI_SPAWNER_DEFERRED_MESSAGE` with `CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE`; replaced the `case 'claude-cli'` arm with a defense-in-depth throw; cleaned related comment + flag-description text.
- `pipeline-cli/src/cli/orchestrator.ts`: removed `emitClaudeCliDeprecationWarning` import + both invocations; updated `--spawner` help text.
- `pipeline-cli/src/orchestrator/loop.ts`: removed `claude-cli` from `resolveEnvUmbrellaSpawnerKind` (now throws a pointed migration error); dropped the dead `claude-cli`-guarded `api-key` retry branch in `buildDefaultUmbrellaDispatch`; refreshed surrounding comments.
- `pipeline-cli/src/types.ts`: removed `'manifest-emitted'` from the `SubagentResult.status` union (no in-tree spawner emits it anymore).
- `pipeline-cli/src/runtime/spawners/dispatch-result.ts`: rewrote the module-level docstring to drop ClaudeCliInlineSpawner references; the runtime API is unchanged (still used by the AISDLC-225 consumer bridge).
- `pipeline-cli/src/cli/execute.test.ts`, `pipeline-cli/src/cli/orchestrator.test.ts`, `pipeline-cli/src/orchestrator/loop.umbrella.test.ts`, `pipeline-cli/src/runtime/spawners/dispatch-result.test.ts`: removed claude-cli-spawner-specific tests; added a defense-in-depth `claude-cli`-rejected test; reframed the spawner-fallback suite as the no-retry contract.
- Documentation refreshes: `CLAUDE.md` spawner table, `pipeline-cli/README.md`, `pipeline-cli/docs/spawner.md` (removed Deprecated section), `pipeline-cli/docs/orchestrator.md`, `docs/operations/{README,orchestrator-runbook,operator-runbook,recovery-flows,billing-and-cost-optimization}.md`, `ai-sdlc-plugin/commands/orchestrator-tick.{md,test.mjs}`.

### Design decisions

- **Preserve `dispatch-result.{ts,test.ts}`** — the producer (`ClaudeCliInlineSpawner`) is gone, but the consumer-bridge half is still used by `cli-orchestrator tick --continue-from-result <path>` and by the `/ai-sdlc orchestrator-tick` slash command body's `write-dispatch-result` subcommand. Deleting it would break Pattern X v2's hand-off contract.
- **AC #5 reinterpretation, not literal compliance** — Pattern X v2 (AISDLC-396) explicitly uses `Agent(... run_in_background:true)` as the core developer-dispatch mechanism in the `/ai-sdlc orchestrator-tick` slash command body. A literal grep test would break the documented design. Scoped AC #5 to "no orphaned `Agent(... run_in_background)` calls remain from the deleted claude-cli inline-manifest path" — met by virtue of deleting `claude-cli-inline.ts` + `deprecation-warnings.ts` entirely. Documented in the migration breadcrumb's "Implementation note — AC #5" section for operator sign-off.
- **Keep `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` env var as a no-op configuration hook** — it still triggers `FALLBACK_BILLING_WARNING` so operators see the same diagnostic; the retry guard is now dead code (no spawner kind matches `'claude-cli'`). Documented in the loop.ts comments + `pipeline-cli/docs/orchestrator.md`.

### Verification

- `pnpm build` — clean across all packages (reference, pipeline-cli, orchestrator, dashboard, mcp-advisor, etc.)
- `pnpm test` — clean (pipeline-cli alone: 274 test files / 5273 tests pass; full workspace also pass)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- (none)
