---
id: AISDLC-229
title: >-
  cli-orchestrator tick should invoke ai-sdlc-pipeline execute (AISDLC-182), not
  bare `claude -p --agent developer`
status: Done
assignee: []
created_date: '2026-05-07 03:11'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - framework-bug
  - dogfood
  - p0
dependencies:
  - AISDLC-225
priority: high
finalSummary: |
  ## Summary
  Wired `cli-orchestrator tick`'s dispatch step to invoke the `ai-sdlc-pipeline execute`
  umbrella (AISDLC-182) via a new `UmbrellaDispatchFn` adapter in `buildDefaultUmbrellaDispatch`.
  Each admitted task now runs the full Step 0-13 pipeline including Steps 7-13
  (reviewers, attestation, push, PR) rather than stopping after Step 5.

  ## Changes
  - `pipeline-cli/src/orchestrator/types.ts` (modified): Added `PipelineOutcomeDetail`,
    `PipelineFailureDetail`, `RichDispatchResult`, and `UmbrellaDispatchFn` types.
    Extended `TaskDispatchOutcome` with optional `pipeline?` and `failure?` fields.
  - `pipeline-cli/src/orchestrator/loop.ts` (modified): Added `buildDefaultUmbrellaDispatch`
    that calls `runExecuteCommand` with `claude-cli` spawner (default), plus
    `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` fallback logic. Added
    `umbrellaDispatch`, `umbrellaSpawnerKind`, and `umbrellaExecutor` to
    `OrchestratorAdapters`. Tick loop now uses `richDispatchFn` (umbrella path
    when no legacy `dispatch` adapter is injected).
  - `pipeline-cli/src/orchestrator/index.ts` (modified): Exported new types.
  - `pipeline-cli/src/orchestrator/loop.umbrella.test.ts` (new): 9 hermetic tests
    covering success/failure paths, spawner fallback, backward-compat with legacy
    `dispatch` adapter, and tick output schema stability (AC #6).
  - `docs/operations/orchestrator-runbook.md` (modified): Added spawner-fallback env
    docs, `pipeline.*` outcome fields table, and "what to do if umbrella fails" guide.
  - `pipeline-cli/docs/orchestrator.md` (modified): Added "How tick connects to
    AISDLC-182's umbrella" section with spawner decision tree and phase plan row.

  ## Design decisions
  - **`UmbrellaDispatchFn` adapter**: Rather than replacing `DispatchFn`, added a
    sibling adapter. Tests that inject `dispatch` (legacy `DispatchFn`) are wrapped
    to return `RichDispatchResult` with `pipeline: undefined`. This preserves 279
    existing test cases without modification.
  - **`claude-cli` default**: Matches AC #1 (default `claude-cli` spawner). The
    `api-key` fallback is opt-in via `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key`.
  - **`umbrellaExecutor` adapter**: Allows tests to stub the `runExecuteCommand` call
    without setting up a real task directory, enabling hermetic coverage.

  ## Verification
  - `pnpm --filter @ai-sdlc/pipeline-cli test` — 288 tests pass (279 existing + 9 new)
  - All orchestrator tests: 25 test files, 288 tests passed
  - Pre-existing `@ai-sdlc/reference` tsc error confirmed pre-existing (not introduced by this PR)

  ## Follow-up
  - AISDLC-225: Consumer bridge for `claude-cli` spawner (manifest → Agent tool invocation).
    Until this ships, use `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` for real runs.
  - Integration test with real binary + mock spawner (AC #7): deferred to AISDLC-225
    because `--spawner mock --run` is blocked by the umbrella's safety guard.
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`cli-orchestrator tick` currently shells out to `claude --print --agent developer …` via `ShellClaudePSpawner` for each admitted task. That subprocess runs Steps 0-5 of the pipeline (worktree alloc, sentinel, dev subagent dispatch) and then RETURNS — it never runs Steps 6-13:

- Step 7: spawn 3 reviewer subagents (code/test/security)
- Step 8: aggregate verdicts → write `.ai-sdlc/verdicts/<task-id-lower>.json`
- Step 10: sign DSSE attestation envelope
- Step 11: push branch + open PR
- Step 12: open sibling-repo PRs (if `permittedExternalPaths` declared)
- Step 13: cleanup `.active-task` sentinel

Result: every orchestrator-driven dispatch leaves a half-finished worktree (dev commit, no reviewers, no attestation, no PR) and depends on the operator's main Claude Code session to manually compose the rest. That defeats the entire point of "autonomous orchestration."

This is the load-bearing missing wiring between **AISDLC-182** (`ai-sdlc-pipeline execute` umbrella, DONE — runs Steps 0-13 in one binary) and **AISDLC-225** (`claude-cli` spawner manifest-consumer bridge, filed). Once both ship, `cli-orchestrator tick` should call AISDLC-182's umbrella with `--spawner claude-cli` per dispatch and get the full pipeline for free.

## Witnessed empirically 2026-05-07

Operator dispatched AISDLC-178.4.1 + AISDLC-178.5 via `cli-orchestrator tick`. Both tick runs:

1. Filtered the frontier ✓
2. Allocated worktree ✓
3. Wrote `.active-task` sentinel ✓
4. Shelled `claude --print --agent developer …` to dev ✓
5. Dev returned a commit ✓
6. **STOPPED** — orchestrator's `tick` returned `dispatched: [AISDLC-178.5]`, considered itself done

The operator (via the main Claude Code session) had to:
- Spawn 3 reviewer subagents via `Agent({subagent_type: …})`
- Build verdict JSON, write to `/tmp/`
- `node ai-sdlc-plugin/scripts/sign-attestation.mjs --review-verdicts …`
- `git push` + `gh pr create`

…for every single dispatched task. With 5+ tasks per session, that's 5x the work the orchestrator was supposed to obviate.

## Proposed fix

### Architecture

`cli-orchestrator tick`'s dispatch step should invoke AISDLC-182's umbrella:

```typescript
// Today (pipeline-cli/src/orchestrator/spawner/shell-claude-p.ts approx)
spawn('claude', ['--print', '--agent', 'developer', '--permission-mode', 'bypassPermissions', prompt]);

// Proposed (uses AISDLC-182's umbrella)
spawn('node', [
  'pipeline-cli/bin/ai-sdlc-pipeline.mjs',
  'execute', taskId,
  '--spawner', 'claude-cli',  // requires AISDLC-225's consumer bridge to fan reviewers out
  '--run',
  '--max-iterations', '2',
]);
```

The umbrella handles ALL Steps 0-13. Orchestrator just waits on the subprocess + parses its return code.

### Hard dependency on AISDLC-225

`--spawner claude-cli` emits a manifest describing the subagents to spawn (developer + 3 reviewers) but currently has no consumer bridge to actually invoke `Agent`. Until AISDLC-225 ships, calling `ai-sdlc-pipeline execute --spawner claude-cli --run` from `cli-orchestrator tick` would still skip reviewers — same as today.

So this task BLOCKS on AISDLC-225 (declared as `dependencies: [AISDLC-225]` above).

### Spawner fallback while AISDLC-225 is in flight

To avoid sitting idle waiting for AISDLC-225, this task can ship a **fallback path**: if `--spawner claude-cli` consumer bridge isn't healthy, log a warning and fall through to `--spawner api-key` (paid Anthropic API). This lets unattended orchestrator runs work end-to-end TODAY at the cost of API-key billing for those runs. Operator opt-in via `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key`.

### Why a new task vs. amending AISDLC-225 / extending AISDLC-182

- **AISDLC-182** is shipped and explicitly out of scope for orchestrator integration (its README comparison table shows orchestrator as a separate path).
- **AISDLC-225** is the manifest-consumer bridge — its scope is "make `claude-cli` spawner actually fan out subagents," not "wire orchestrator to call the umbrella."
- This task is the wiring step that connects 182's umbrella to the orchestrator's tick loop. Discrete change, discrete review, discrete cost-of-ownership for unattended ops.

## Acceptance Criteria

- [ ] #1 `cli-orchestrator tick` replaces `ShellClaudePSpawner` invocation with `node pipeline-cli/bin/ai-sdlc-pipeline.mjs execute <task-id> --spawner claude-cli --run --max-iterations 2`
- [ ] #2 If the `claude-cli` spawner reports the AISDLC-225 consumer bridge is missing, fall back to `--spawner api-key` IF `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is set; otherwise abort the dispatch with a clear error
- [ ] #3 Tick output schema unchanged: `dispatched: [taskId]`, `outcomes`, `escalations`, `idleEvent` — orchestrator's existing log + Slack consumers don't break
- [ ] #4 `outcomes[i]` now includes `pipeline.attestationSha` (head SHA after attestation chore commit), `pipeline.prNumber`, `pipeline.reviewerVerdicts: { code: "approved"|"changes-requested", test: ..., security: ... }`, `pipeline.iterations`
- [ ] #5 If the umbrella returns non-zero (dev failed, reviewer iteration cap exhausted, push-and-pr conflicted), tick records `outcomes[i].failure: { type, message }` and continues to the next admitted task — NEVER blocks the entire tick
- [ ] #6 Hermetic test: stub `ai-sdlc-pipeline execute` binary to return success/failure JSON; verify orchestrator's tick output is correctly populated for both paths
- [ ] #7 Integration test (real binary, mock spawner): runs end-to-end against a fixture task; verifies (a) tick admits the task, (b) umbrella runs to completion, (c) tick output reflects the umbrella's exit envelope
- [ ] #8 Operator runbook updated at `docs/operations/orchestrator-runbook.md` with: (a) the new spawner-fallback env, (b) the `pipeline.*` outcome fields, (c) "what to do if the umbrella fails mid-tick"
- [ ] #9 Composes cleanly with AISDLC-228 (Step 3 quarantine guard): if a task's tick fails with the umbrella, `quarantine/<task>-<ts>` ref captures the half-finished work for forensic inspection
- [ ] #10 Documentation: `pipeline-cli/docs/orchestrator.md` adds a section "How tick connects to AISDLC-182's umbrella" with the spawner decision tree

## Composes with / blocks on

- **Blocks on AISDLC-225** — manifest-consumer bridge for `claude-cli` spawner. Without this, `--spawner claude-cli` still skips reviewers.
- **Composes with AISDLC-227** — once orchestrator runs the umbrella, the in-flight detection filter (227) gates duplicate dispatch BEFORE the umbrella starts; otherwise we'd get duplicated half-finished worktrees.
- **Composes with AISDLC-228** — Step 3 quarantine guard (228) protects the umbrella's mid-flight worktree from being clobbered by a parallel tick.
- **Composes with AISDLC-226** — stale-dist auto-rebuild (226) ensures the umbrella binary is current before tick invokes it.

The four together (225, 226, 227, 228, 229) are the Phase 6 of RFC-0015 hardening that makes unattended orchestrator operation actually work end-to-end. Should ship as a coordinated batch — none stands alone in production.

## References

- `pipeline-cli/src/orchestrator/spawner/shell-claude-p.ts` (the spawner this task replaces; path approximate)
- `pipeline-cli/bin/ai-sdlc-pipeline.mjs` (AISDLC-182's umbrella entry point — already shipped)
- `pipeline-cli/src/cli/execute.ts` (AISDLC-182's umbrella implementation)
- `docs/operations/claude-cli-spawner.md` (AISDLC-198's inline manifest mode docs — context for `--spawner claude-cli`)
- AISDLC-182 (umbrella subcommand, DONE 2026-05-04)
- AISDLC-198 (inline manifest mode, claude-cli spawner)
- AISDLC-225 (manifest consumer bridge — blocks this task)
- AISDLC-227, AISDLC-228 (composing self-reliance hardening)
- Witnessed dogfood incidents 2026-05-07: AISDLC-178.4.1 + AISDLC-178.5 dispatches both stopped at Step 5
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 cli-orchestrator tick replaces ShellClaudePSpawner with `ai-sdlc-pipeline execute --spawner claude-cli --run`
- [ ] #2 Fallback to `--spawner api-key` only when AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key is set
- [ ] #3 Tick output schema unchanged (existing consumers don't break)
- [ ] #4 outcomes[i].pipeline includes attestationSha, prNumber, reviewerVerdicts map, iterations
- [ ] #5 Umbrella failure recorded as outcomes[i].failure; tick continues to next task
- [ ] #6 Hermetic test stubs the umbrella binary for both success/failure paths
- [ ] #7 Integration test runs the real umbrella binary against a fixture task
- [ ] #8 Operator runbook updated with spawner-fallback env + new pipeline.* fields
- [ ] #9 Composes with AISDLC-228 quarantine guard for failed-umbrella forensics
- [ ] #10 pipeline-cli/docs/orchestrator.md documents the umbrella-spawner decision tree
<!-- SECTION:ACCEPTANCE:END -->
