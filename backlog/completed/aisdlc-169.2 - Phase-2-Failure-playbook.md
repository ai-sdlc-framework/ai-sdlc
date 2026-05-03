---
id: AISDLC-169.2
title: 'Phase 2: Failure playbook'
status: Done
assignee: []
created_date: '2026-05-03'
updated_date: '2026-05-02'
labels:
  - rfc-0015
  - phase-2
  - failure-playbook
  - state-machine
milestone: m-3
dependencies:
  - AISDLC-169.1
parent_task_id: AISDLC-169
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0015. Implement the deterministic 8-mode failure playbook from §5.1 (plus `StackedPRBaseSquashed` = 9 patterns total per Q9), the worker state machine semantics (§5.2), and the versioned failure-pattern catalogue (§13 Q9). Each failure mode gets a detection signal, remediation handler, retry budget, and escalation path — with synthetic-trigger tests per mode. Estimated 1.5 weeks.

Per RFC §13 Q4: remediation runs **per-worker, parallel, no global locks**. Each worker operates on its own worktree + branch (RFC-0010 §7); the file-based merge gate (RFC-0010 §10.1) already handles the only legitimate global serialization (push-to-main ordering). Phase 2 implementers MUST audit each new handler for hidden global-state mutations; v1 default is parallel-no-lock. Per-mode locks (RFC §13 Q4 Option C) added only if a real global-state collision surfaces.

## Open-question resolutions implemented in this phase

- **Q4 (parallel remediation):** No global locks in v1. Each handler scoped to its worker's branch. Audit hook in code review.
- **Q7 (per-project config foundation):** Failure budgets default to §5.1 values; per-project override mechanism via `.ai-sdlc/orchestrator-config.yaml` lands in Phase 4. Phase 2 ships the in-memory budget representation that Phase 4 wires to YAML.
- **Q8 (UnknownFailureMode wiring):** Phase 1 staked out the schema; Phase 2 wires it as the conservative fall-through for any failure that doesn't match a catalogue pattern.
- **Q9 (pattern catalogue + versioning):** `.ai-sdlc/orchestrator-failure-patterns.yaml` is the single source of truth, validated against `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json`. Ships with the 9 default patterns from §5.1 (8 original + `StackedPRBaseSquashed`). Per-project override extends or replaces.

## The 9 patterns (§5.1 + post-iteration addition)

| Mode | Detection | Remediation | Budget | Escalation |
|---|---|---|---|---|
| `SecretScanBlocked` | `git push` rejected with `push declined due to repository rule violations` + `Secret Scanning` mention | Detect file/line; reformat literal-secret patterns to template-literal construction; recommit; retry push | 2 | `needs-human-attention` + `RemediationFailed{mode: SecretScanBlocked}` |
| `PushRaceWithMergeQueue` | `git push` rejected with `protected branch hook declined` + `queued for merging` mention | Sleep 60s + retry push | 3 | Sleep 5min; retry once; emit `MergeQueueStuck` |
| `RebaseConflict` | `git rebase origin/main` exits non-zero with `<<<<<<< HEAD` markers | Invoke `rebase-resolver` subagent (AISDLC-105) | 1 | Per AISDLC-105 escalation: tag `needs-human-attention` |
| `VerificationFailure` | `pnpm build/test/lint/format` exits non-zero in dev's verify stage | Re-spawn dev with combined verification stderr feedback | 2 | Ship as `needs-human-attention` |
| `ReviewerMajorOrCritical` | Aggregated verdict has any `critical` or `major` finding | Re-spawn dev with combined reviewer feedback | 2 | Ship as `needs-human-attention` |
| `EnvHookFailure` | husky pre-commit fails with `tsc not found` / similar env-not-tooling error | Retry with `--no-verify` if change is data-only (backlog/, docs/, no source code); emit `EnvHookSkipped` for audit | 1 | Emit `EnvHookFailed`; leave commit local |
| `AttestationVerifyMismatch` | CI's `ai-sdlc/attestation` reports `contentHashV3 mismatch` after sibling PR merge | Pre-sign rebase per AISDLC-102 (already shipped); re-spawn 3 reviewers if `contentHashV3` changed | 1 | Emit `AttestationStaleAfterRebase` |
| `LongRunningPRBlocksWorker` | A worker's PR open + queued for >2h without merge OR rejection | Park worker; release worktree (PR continues independently); orchestrator picks next task | n/a | Emit `WorkerParked` |
| `StackedPRBaseSquashed` | Previously-opened PR's `mergeStateStatus` flips to `DIRTY` AND base PR was merged via non-merge-commit strategy (squash OR rebase). Detect: `gh pr view <base-pr> --json state,mergedAt` returns `MERGED` AND main has a recent commit overlapping the chain's content | `git fetch origin main && git rebase origin/main` (`--reapply-cherry-picks` skips squashed/rebased-out commits); `--force-with-lease` push | 1 | Manual review on rebase conflict. Alt: open fresh PR from rebased branch with base=main |

## Components

- **Worker state machine** (§5.2): explicit transitions `DEV_RUNNING → REVIEW_RUNNING → FINALIZING → DONE` with branches for ITERATE_DEV, REMEDIATE_*, SLEEP_RETRY, NEEDS_HUMAN_ATTENTION → DONE_WITH_FLAG. Each transition emits a `WorkerStateTransition` event.
- **Per-mode handler modules**: one TS module per mode under `ai-sdlc-plugin/orchestrator/handlers/<mode>.ts`; each exports `{ detect(stderr, context): boolean, remediate(worker): RemediationOutcome, budget: number }`.
- **Pattern catalogue YAML**: `.ai-sdlc/orchestrator-failure-patterns.yaml` ships with the 9 default patterns. Each entry: `{ mode, detect: { regex | exitCode | matchKind }, handler: <module-name>, budget, escalation }`. Validated against `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json` at orchestrator startup.
- **State persistence**: `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` — per-worker state for forensics + `cli-status --orchestrator` view (Phase 4). Per Q2, NOT used for resume.
- **Synthetic-trigger test harness**: per-mode tests inject the canonical detection signal (e.g., a fake stderr string or exit code) and verify the matching handler fires + the worker's state transition + the events.jsonl entries.

## Audit checklist for Q4 (parallel remediation, no global locks)

Each handler MUST be reviewed against:

1. **No writes to `OrchestratorConfig` in-memory state** (e.g., `failureBudgets[mode]++` is a global mutation — disallowed).
2. **No writes outside the worker's worktree branch** (other than the merge-gate-mediated `git push`).
3. **No invalidation of shared caches** (the orchestrator has no caches per RFC-0014 Q4; this remains true here).
4. **`gh` calls scoped to the worker's PR number** (`gh pr edit <pr-num>`, NOT `gh pr edit` with implicit current-branch resolution that could race).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Worker state machine (RFC §5.2) ships with explicit transitions; each transition emits a `WorkerStateTransition` event with `{from, to, duration_ms, context}` per the events.jsonl schema staked in Phase 1
- [x] #2 All 9 patterns from §5.1 (+ `StackedPRBaseSquashed`) ship as separate handler modules under `pipeline-cli/src/orchestrator/playbook/handlers/<mode>.ts` (relocated from the task description's `ai-sdlc-plugin/orchestrator/handlers/` because pipeline-cli now owns the orchestrator code path); each exports `{ detect, remediate, budget }`
- [x] #3 Q9 versioned catalogue: `.ai-sdlc/orchestrator-failure-patterns.yaml` ships with the 9 default patterns; orchestrator startup validates against `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json` and refuses to start on schema-violation
- [x] #4 Q4 parallel remediation: handlers run per-worker without global locks; PR review gate includes the audit checklist (no `OrchestratorConfig` writes, no out-of-worktree writes, no shared cache invalidation, `gh` scoped to worker PR num)
- [x] #5 Q8 UnknownFailureMode wiring: any failure that escapes the catalogue triggers conservative fall-through — emits `UnknownFailureMode` event, tags PR `needs-human-attention`, does NOT attempt remediation
- [x] #6 Per-mode test coverage: each of the 9 patterns has a synthetic-trigger test that injects the detection signal, asserts the matching handler fires, asserts the worker's state transitions, asserts the events.jsonl entries are emitted
- [x] #7 State persistence: `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` written on every state transition; per Q2 used for forensics + Phase 4 `cli-status --orchestrator` view, NOT for crash resume
- [x] #8 Phase 2 acceptance fixture (per RFC §11 Phase 2): 90%+ of injected failures recover automatically; remaining 10% escalate to `needs-human-attention` cleanly with the expected event trail
- [x] #9 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Implementation summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
### Summary

RFC-0015 Phase 2 — the deterministic 9-mode failure playbook from §5.1 — ships with per-handler synthetic-trigger tests, the worker state machine (§5.2), the versioned `.ai-sdlc/orchestrator-failure-patterns.yaml` source-of-truth (Q9), and the wiring into `runOrchestratorTick` so dispatch failures route through catalogued remediation before falling through to the Phase 1 `UnknownFailureMode` catch-all (Q8). The 10-task acceptance fixture asserts 100% recovery on the 9 catalogued cases + clean fall-through on the 1 unknown case (≥90% per RFC §11 Phase 2 AC).

### Changes

- `pipeline-cli/src/orchestrator/playbook/types.ts` (new): shared types — `FailureMode`, `WorkerState`, `WorkerContext`, `RemediationOutcome`, `Handler`, `HandlerDeps`, `WorkerStateTransitionEvent`, `RemediationApplied/Failed/WorkerParked` event shapes, `MODE_TO_REMEDIATE_STATE`, `CATALOGUED_MODES` priority order, `PersistedWorkerState`.
- `pipeline-cli/src/orchestrator/playbook/handlers/{secret-scan-blocked,push-race,rebase-conflict,verification-failure,reviewer-major-or-critical,env-hook-failure,attestation-verify-mismatch,long-running-pr,stacked-pr-base-squashed}.ts` (9 new): one module per RFC §5.1 mode + the post-iteration `StackedPRBaseSquashed`. Each exports a `Handler` with `detect`, `remediate`, `budget`, optional `escalate`. Per-attempt only — runner enforces budget (cleanly honors operator catalogue overrides).
- `pipeline-cli/src/orchestrator/playbook/registry.ts` (new): registry ordering + `assertRegistryConsistency()` invariant.
- `pipeline-cli/src/orchestrator/playbook/catalogue.ts` (new): YAML loader for `.ai-sdlc/orchestrator-failure-patterns.yaml` + in-process shape validation; mirrors `dor-config.ts` style (no js-yaml dep).
- `pipeline-cli/src/orchestrator/playbook/state-machine.ts` (new): `WorkerStateTracker` emits transition events + persists `<artifactsDir>/_orchestrator/workers/<id>.state.json` for forensics (Q2 — NOT for resume).
- `pipeline-cli/src/orchestrator/playbook/playbook-runner.ts` (new): `runPlaybook(ctx, opts)` walks registry, drives remediation up to budget, escalates with `RemediationFailed` + state transition; honors operator `escalateImmediately` / `budget: 0` overrides; per-mode escalation (`LongRunningPRBlocksWorker` parks without PR label).
- `pipeline-cli/src/orchestrator/playbook/index.ts` (new): public surface.
- `pipeline-cli/src/orchestrator/playbook/{handlers,catalogue,playbook-runner,registry,state-machine,integration}.test.ts` (new): 6 test files; per-handler synthetic triggers (41 tests), catalogue parser/loader (13), state-machine + persistence (6), playbook-runner outcomes (8), registry consistency (5), 10-task acceptance fixture (1).
- `pipeline-cli/src/orchestrator/loop.ts` (modified): added `tryPlaybookOnError` bridge so dispatch throws route through the playbook before the Phase 1 catch-all; added `OrchestratorAdapters.catalogue` + `persistWorkerState` knobs; per-tick catalogue load.
- `pipeline-cli/src/orchestrator/loop.playbook.test.ts` (new): loop ↔ playbook integration tests (recovery, catalogue override, fall-through, Phase 1 needs-human-attention compat).
- `pipeline-cli/src/orchestrator/types.ts` (modified): `EscalationRecord.event` widened from `'UnknownFailureMode'` literal to the union of all 9 catalogued modes + `UnknownFailureMode`; `OrchestratorTickResult` adds optional `playbookEvents` array.
- `pipeline-cli/src/orchestrator/index.ts` (modified): re-exports the playbook surface.
- `.ai-sdlc/orchestrator-failure-patterns.yaml` (new): canonical 9-pattern catalogue (Q9 source-of-truth).
- `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json` (new): JSON Schema for the catalogue (CI validates).
- `pipeline-cli/docs/orchestrator.md` (modified): replaces "Phase 1 = bare" failure-handling section with the full Phase 2 catalogued playbook walkthrough — 9-mode reference table, state machine diagram, per-project override example, Q4 audit checklist.
- `docs/operations/operator-runbook.md` (modified): adds "Autonomous orchestrator playbook events (RFC-0015 Phase 2)" subsection covering `WorkerStateTransition`/`RemediationApplied`/`RemediationFailed`/`WorkerParked` + a per-mode escalation reference operators can grep when a `RemediationFailed` event fires.

### Design decisions

- **Runner enforces budget; handlers are per-attempt**: removed the early `attempts >= this.budget` check from each handler so operator catalogue overrides (`budget: 0`, `escalateImmediately: true`) actually win. The runner walks `for (attempt < budget)` and calls escalate on loop exit. Reason: the previous design shadowed YAML overrides because `this.budget` is the hardcoded handler default, not the catalogue-effective value. Tradeoff: tests that asserted handler-side budget enforcement now assert on the runner level.
- **YAML loader is in-process, no js-yaml dep**: mirrors `pipeline-cli/src/dor/dor-config.ts` style. The catalogue is small + fixed-shape; CI runs the JSON Schema validator against the same file so ajv runtime overhead isn't justified. Hard-rejects unknown keys + unknown modes per Q9 strict.
- **Catalogue-vs-handler division**: handler MODULES are the single source of truth for remediation logic (regex + git/gh shellouts). The YAML carries only `budget`, `escalateImmediately`, and operator-facing `description`. Operators can change behaviour shape via PRs against the handler modules; they tune retry policy via the YAML.
- **`tryPlaybookOnError` synthesises `exitCode: 1` from thrown dispatch errors**: the underlying tool exit code isn't propagated through `Error.message`, but the dispatch failed by definition. Handlers that need a specific code (`EnvHookFailure` looks for 127) still validate via stderr regex, so the synthetic value doesn't open a misclassification gap.
- **`LongRunningPRBlocksWorker` ships a custom escalator that does NOT label**: parking is not a defect (the PR is mergeable; operator just decided not to wait per RFC §13 Q6). The escalator override prevents the generic `needs-human-attention` label from firing on a parked worker's PR.
- **Per-worker state file written on every transition**: `<artifactsDir>/_orchestrator/workers/<id>.state.json`. Per Q2 it's forensic-only; Phase 4 reads it for `cli-status --orchestrator`. We bound history to 64 entries to keep the file tight.
- **Path moved to `pipeline-cli/src/orchestrator/playbook/`**: the task description references `ai-sdlc-plugin/orchestrator/handlers/`, but per the Phase 1 implementation (and the AISDLC-156 invocation pattern + the orchestrator code already living in `pipeline-cli/src/orchestrator/`), all new playbook code is colocated with `loop.ts`. The handler file naming `<mode>.ts` matches the task's stated convention.

### Verification

- `pnpm build` — clean
- `pnpm test` — 1392 pipeline-cli tests pass (97 new playbook tests + 14 existing loop tests still pass), workspace test suite green across `reference`, `pipeline-cli`, `mcp-server`, `sdk-typescript`, `orchestrator` (legacy) packages
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- Phase 3 (AISDLC-169.3) wires DoR + dependency + external-deps pre-dispatch admission filters + the exponential-backoff polling cadence (Q3, Q5).
- Phase 4 (AISDLC-169.4) replaces the in-memory `playbookEvents` array with the canonical `events.jsonl` writer + `cli-status --orchestrator` view; promotes `<worker-id>.state.json` from forensic-only to driving the operator dashboard.
- Phase 5 (AISDLC-169.5) runs the soak corpus, chaos test (kill mid-tick), and produces the promotion runbook.
<!-- SECTION:FINAL_SUMMARY:END -->
