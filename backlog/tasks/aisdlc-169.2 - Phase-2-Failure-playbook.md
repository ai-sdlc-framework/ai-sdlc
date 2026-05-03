---
id: AISDLC-169.2
title: 'Phase 2: Failure playbook'
status: To Do
assignee: []
created_date: '2026-05-03'
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
- [ ] #1 Worker state machine (RFC §5.2) ships with explicit transitions; each transition emits a `WorkerStateTransition` event with `{from, to, duration_ms, context}` per the events.jsonl schema staked in Phase 1
- [ ] #2 All 9 patterns from §5.1 (+ `StackedPRBaseSquashed`) ship as separate handler modules under `ai-sdlc-plugin/orchestrator/handlers/<mode>.ts`; each exports `{ detect, remediate, budget }`
- [ ] #3 Q9 versioned catalogue: `.ai-sdlc/orchestrator-failure-patterns.yaml` ships with the 9 default patterns; orchestrator startup validates against `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json` and refuses to start on schema-violation
- [ ] #4 Q4 parallel remediation: handlers run per-worker without global locks; PR review gate includes the audit checklist (no `OrchestratorConfig` writes, no out-of-worktree writes, no shared cache invalidation, `gh` scoped to worker PR num)
- [ ] #5 Q8 UnknownFailureMode wiring: any failure that escapes the catalogue triggers conservative fall-through — emits `UnknownFailureMode` event, tags PR `needs-human-attention`, does NOT attempt remediation
- [ ] #6 Per-mode test coverage: each of the 9 patterns has a synthetic-trigger test that injects the detection signal, asserts the matching handler fires, asserts the worker's state transitions, asserts the events.jsonl entries are emitted
- [ ] #7 State persistence: `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` written on every state transition; per Q2 used for forensics + Phase 4 `cli-status --orchestrator` view, NOT for crash resume
- [ ] #8 Phase 2 acceptance fixture (per RFC §11 Phase 2): 90%+ of injected failures recover automatically; remaining 10% escalate to `needs-human-attention` cleanly with the expected event trail
- [ ] #9 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
