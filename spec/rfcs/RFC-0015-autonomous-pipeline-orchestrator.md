---
id: RFC-0015
title: Autonomous Pipeline Orchestrator
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-01
updated: 2026-05-01
targetSpecVersion: v1alpha1
requires:
  - RFC-0010
  - RFC-0011
  - RFC-0012
  - RFC-0014
requiresDocs: []
---

# RFC-0015: Autonomous Pipeline Orchestrator

**Document type:** Normative (draft)
**Status:** Draft (initial seed; structure may shift; open questions in §13)
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-05-01
**Updated:** 2026-05-01
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io (pending)
- [ ] Product owner — Alex (pending)
- [ ] Operator owner — dominique@reliablegenius.io (pending)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-05-01 | dominique | Initial draft. Closes the "outer loop" gap between RFC-0010 (parallel execution), RFC-0011 (DoR), RFC-0014 (dependency graph), and AISDLC-117 (cli-deps). Single-sandbox first; multi-sandbox deferred to a future RFC. |

---

## 1. Summary

`/ai-sdlc execute <task-id>` ships one task at a time and requires a human (or `/loop`) to invoke it per task. RFC-0010 ships the parallelism primitives (worktree pool, port allocator, harness adapters, subscription scheduling). RFC-0011 ships the admission gate. RFC-0014 ships dependency-aware priority. AISDLC-117 ships the dispatch frontier query. **The piece missing is the outer loop that ties them into a long-running service.**

This RFC scopes a single-sandbox **Autonomous Pipeline Orchestrator** — a long-running process that reads the dispatch frontier, selects N tasks by composite priority, dispatches N concurrent `executePipeline()` runs (RFC-0012 Tier 2), and handles known failure modes via a **deterministic playbook** rather than human judgment.

The thesis: ~95% of pipeline failures fall into 6-8 recognizable categories with mechanical fixes. Encoding those as state-machine transitions removes the human-in-the-loop for the common case and concentrates judgment on genuinely-novel failures.

## 2. Motivation

### 2.1 What's automated today

Today's `/ai-sdlc execute` flow IS deterministic for the happy path:

1. Worktree setup — `git worktree add` + sentinel write
2. Dev prompt assembly — template + task content
3. Verification gates — `pnpm build/test/lint/format`
4. Reviewer fan-out — 3 parallel agents with templated prompts
5. Verdict aggregation — count thresholds (0c+0M → APPROVED)
6. Finalization — frontmatter edit, file move, sign attestation, commit, push, PR

The LLM-driven judgment lives in 2 places: the dev's actual implementation, and the reviewers' actual review quality. Everything else is mechanical.

### 2.2 What's NOT automated today

Failure recovery. Every time a known failure mode occurs (secret-scan block, merge-queue race, rebase conflict, verification regression, reviewer flagging a major issue), a human (or Claude in interactive mode) decides what to do. Empirically over the last 24 hours we hit:

- **Secret-scan block on test fixtures** (PR #154 / AISDLC-126) — fix: reformat to template-literal so source doesn't contain literal pattern. Mechanical.
- **Push race vs merge queue** (PR #151 closure attempt) — fix: wait + retry. Mechanical.
- **Branch BEHIND main after sibling PR merged** — fix: `git rebase origin/main` + force-push-with-lease. Mechanical (already automated as `/ai-sdlc rebase`, AISDLC-105).
- **`pnpm typecheck` env failure (mcp-server missing tsc)** — fix: commit with `--no-verify` for data-only changes. Judgment-adjacent but encodable.
- **Reviewer flagging major** — fix: re-spawn dev with combined feedback (cap 2). Already encoded in `/ai-sdlc execute` Step 9 but not exposed as a service.
- **Iteration cap exceeded** — fix: ship as `[needs-human-attention]`. Encoded.

These cases are recurring and deterministic. Encoding them removes ~95% of the supervision burden.

### 2.3 What this enables

- **Unattended throughput** — operator sets the queue, walks away, wakes up to N+M PRs (N merged, M needs-human-attention).
- **Cleaner observability** — every state transition is an event. Dashboards consume the event stream rather than scraping logs.
- **Foundation for multi-sandbox** — once single-sandbox proves the deterministic model, scaling is "spawn more sandboxes pointed at the same backlog with a claim/lease layer."

## 3. Goals and Non-Goals

### Goals

- Long-running orchestrator process that drives the pipeline without per-task human invocation.
- Deterministic failure playbook covering the 6-8 known recurring failure modes from §2.2.
- Bounded concurrency within a single sandbox (defaults from RFC-0010 §9.1's tier-aware table).
- Pre-dispatch filtering by DoR readiness (RFC-0011) + dependency unblock (AISDLC-117) + composite priority (RFC-0014 Q1).
- Event-stream emission at every state transition for downstream observability consumers.
- Opt-in via feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`; existing `/ai-sdlc execute` continues to work unchanged.

### Non-Goals

- **Multi-sandbox coordination.** Defer. Single-sandbox first; once proven, a follow-up RFC adds claim/lease semantics.
- **Real-time dashboard.** This RFC defines the event stream; the dashboard is a separate consumer (future RFC).
- **New agent types.** Reuse existing `developer` + 3 reviewer subagents.
- **LLM-side calibration.** RFC-0011 owns DoR calibration; RFC-0014 owns priority composition. This RFC consumes their outputs.
- **Replacing `/ai-sdlc execute` entirely.** The slash command stays as the interactive interface; the orchestrator is the unattended interface. Both call the same `executePipeline()` library (RFC-0012 Tier 2).

## 4. Architecture

### 4.1 Process model

A single Node process running in the operator's sandbox (terminal session, Docker container, GH Actions runner — same machine, same checkout). Driven by an outer loop:

```
loop forever:
  if shutdown_signal: drain → exit
  frontier = cli-deps frontier --status "To Do" --max <N×3>
  candidates = filter(frontier, dor_ready) ∪ resort(by effectivePriority DESC, criticalPathLength DESC, recency DESC)
  in_flight = pool.active_count
  budget = parallelism.maxConcurrent - in_flight
  for task in candidates[:budget]:
    pool.dispatch(task)
  pool.drain_completed(handle_completion)
  sleep(tick_interval)
```

Tick interval default: 30s (configurable via `pipeline.tickIntervalSec`). Long enough to avoid pointless polling, short enough that newly-readied tasks get picked up within the same conversational session.

### 4.2 Worker pool

Bounded by `parallelism.maxConcurrent` from the active `WorktreePool` resource (RFC-0010 §6.7). Each worker:

1. Allocates a worktree (RFC-0010 §7.1) + writes the per-worktree `.active-task` sentinel (AISDLC-81).
2. Calls `executePipeline()` from `@ai-sdlc/pipeline-cli` (RFC-0012 Tier 2) with the configured `SubagentSpawner`.
3. On completion, releases the worktree (RFC-0010 §7.1 `cleanupOnMerge` hook).
4. Reports outcome to the orchestrator's failure handler (§5).

### 4.3 Pre-dispatch admission

Before dispatching a candidate, the orchestrator runs three filters:

1. **Dependency readiness** — `cli-deps blockers <id>` returns empty (all upstream tasks Done or Cancelled).
2. **DoR readiness** — task `dorVerdict` is `admit` per RFC-0011's `refinement-verdict.v1.schema.json`. Tasks with `needs-clarification` are skipped (their author is on the comment-loop hook).
3. **External-dependency presence** — RFC-0014 Q3 adds `externalDependencies:` as informational; if any entry has `kind: 'manual'` and no operator-provided clearance signal, skip with `OrchestratorAwaitingExternal` event.

A candidate that fails any filter is requeued for the next tick — no human notification unless the same task is skipped >5 ticks (then emit `OrchestratorStuckCandidate` so the operator can investigate).

## 5. Failure Playbook

The deterministic core. Each failure mode has a detection signal, a remediation action, a retry budget, and an escalation path.

### 5.1 Failure taxonomy

| Mode | Detection | Remediation | Budget | Escalation |
|---|---|---|---|---|
| `SecretScanBlocked` | git push rejected with `push declined due to repository rule violations` + `Secret Scanning` mention | Detect which file/line; reformat literal-secret patterns to template-literal construction; recommit; retry push | 2 | Tag PR with `needs-human-attention`; emit `RemediationFailed{mode: SecretScanBlocked}` |
| `PushRaceWithMergeQueue` | git push rejected with `protected branch hook declined` + `queued for merging` mention | Sleep 60s + retry push | 3 | Sleep 5min; retry once more; if still failing, leave commit local + emit `MergeQueueStuck` |
| `RebaseConflict` | `git rebase origin/main` exits non-zero with `<<<<<<< HEAD` markers | Invoke existing `rebase-resolver` subagent (AISDLC-105) | 1 | Per AISDLC-105's existing escalation: tag with `[needs-human-attention]` |
| `VerificationFailure` | `pnpm build/test/lint/format` exits non-zero in dev's verify stage | Re-spawn dev with combined verification stderr as feedback | 2 (matches /ai-sdlc execute Step 9) | Ship as `[needs-human-attention]` |
| `ReviewerMajorOrCritical` | Aggregated verdict has any `critical` or `major` finding | Re-spawn dev with combined reviewer feedback | 2 | Ship as `[needs-human-attention]` |
| `EnvHookFailure` | husky pre-commit fails with `tsc not found` / similar env-not-tooling error | Retry with `--no-verify` if change is data-only (backlog/, docs/, no source code); emit `EnvHookSkipped` for audit | 1 | Emit `EnvHookFailed`; leave commit local |
| `AttestationVerifyMismatch` | CI's `ai-sdlc/attestation` reports `contentHashV3 mismatch` after a sibling PR merged | Pre-sign rebase per AISDLC-102 (already shipped); re-spawn 3 reviewers if contentHashV3 changed | 1 | Emit `AttestationStaleAfterRebase` |
| `LongRunningPRBlocksWorker` | A worker's PR has been open + queued for >2h without merge OR rejection | Mark worker as `parked`; release worktree (the PR continues independently); orchestrator picks next task | n/a | Emit `WorkerParked`; operator may intervene if pattern repeats |

### 5.2 State machine semantics

Each failure mode is a transition in the worker's state machine:

```
worker.dispatch
  → DEV_RUNNING
  → (verify_pass) → REVIEW_RUNNING → (approve) → FINALIZING → (push_ok) → DONE
  → (verify_fail, budget>0) → ITERATE_DEV → DEV_RUNNING [loop]
  → (review_changes_requested, budget>0) → ITERATE_DEV
  → (push_secret_block, budget>0) → REMEDIATE_SECRETSCAN → FINALIZING
  → (push_queue_race, budget>0) → SLEEP_RETRY → FINALIZING
  → (any cap exceeded) → NEEDS_HUMAN_ATTENTION → DONE_WITH_FLAG
```

Every transition emits an event (§7). State is persisted to `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` so a crashed orchestrator can resume.

### 5.3 What's explicitly NOT in the playbook

Decisions requiring **product, design, or architectural judgment** are NOT mechanized. Examples:

- Reviewer flags "this design conflicts with RFC-X" — needs human.
- Test fails because the AC was wrong, not the code — needs human.
- Sibling PR merged a competing approach to the same problem — needs human.
- Backlog task references a file that should exist but was never created — needs human (already tracked as AISDLC-125).

These all go through `[needs-human-attention]`. The playbook handles mechanical recoveries; humans handle semantic ones. Stick to that line.

## 6. Integration with Existing RFCs

### 6.1 RFC-0010 (Parallel Execution)

- **Worktree pool**: orchestrator delegates allocation/release to `WorktreePoolManager` (RFC-0010 §7.1). Doesn't reimplement.
- **Port allocator**: workers receive ports via the deterministic allocator (RFC-0010 §8.1).
- **Subscription scheduling**: orchestrator respects `Stage.schedule` hints (off-peak, defer-if-low-priority) per RFC-0010 §14.3. The scheduler is the authority on dispatch timing; orchestrator just doesn't dispatch when scheduler says no.
- **Merge gate**: when a `databaseAccess: migrate` stage runs, orchestrator routes through the file-based merge gate (RFC-0010 §10.1).

### 6.2 RFC-0011 (DoR Gate)

- Pre-dispatch admission filter (§4.3) reads the task's most recent `RefinementVerdict` (per `refinement-verdict.v1.schema.json`).
- Comment-loop ingress (RFC-0011 §6) is OUT of scope for this RFC — DoR feedback to issue authors is its own subsystem; orchestrator only consumes the verdict.
- Bypass via `dor-bypass` label (RFC-0011 §7.4) is honored — bypassed tasks dispatch as if `admit` (with the FYI-shaped blast-radius comment per RFC-0014 Q5).

### 6.3 RFC-0014 (Dependency Graph Composition)

- Candidate selection sort order: `effectivePriority DESC → criticalPathLength DESC → recency DESC` per RFC-0014 Q1 resolution.
- Snapshot emission (RFC-0014 §4.1): orchestrator tags `dispatch` event for the snapshot writer per RFC-0014 Q2.
- Blast-radius surfacing (RFC-0014 §6): when DoR returns `needs-clarification`, orchestrator's pre-dispatch filter reads the blast-radius from the snapshot and lets the comment-loop ingress add the callout.

### 6.4 AISDLC-117 (cli-deps)

- `cli-deps frontier --status "To Do"` is the candidate source.
- `cli-deps blockers <id>` is the dependency-readiness check.
- `cli-deps validate` runs as a sanity check at orchestrator startup; if it reports cycles or dangling refs, orchestrator refuses to start (operator must fix the backlog first).

### 6.5 RFC-0012 (Two-Tier Pipeline)

- Workers call `executePipeline()` (Tier 2 composite). The orchestrator IS a third tier: "service" on top of Tier 2's "library" on top of Tier 1's "slash command body."

## 7. Observability

### 7.1 Event stream

Single append-only file `$ARTIFACTS_DIR/_orchestrator/events.jsonl`. Schema:

```json
{
  "ts": "2026-05-01T22:00:00Z",
  "workerId": "w-3a8f",
  "taskId": "AISDLC-126",
  "event": "WorkerStateTransition",
  "from": "REVIEW_RUNNING",
  "to": "FINALIZING",
  "duration_ms": 612000,
  "context": { "verdicts_summary": "0c/0M/1m/2s" }
}
```

Event types: `OrchestratorTickStart`, `OrchestratorTickEnd`, `WorkerDispatch`, `WorkerStateTransition`, `RemediationApplied`, `RemediationFailed`, `WorkerParked`, `WorkerCompleted`, `OrchestratorAwaitingExternal`, `OrchestratorStuckCandidate`, `EnvHookSkipped`, `AttestationStaleAfterRebase`, `MergeQueueStuck`.

### 7.2 cli-status surface

`cli-status --orchestrator` renders:

- Workers table (id, task, state, age, current stage)
- Candidate queue (next 5 with their composite scores)
- Recent transitions (last 20 events)
- Burn-down (subscription window utilization per RFC-0010 §14.4)

### 7.3 Dashboard consumption (future)

`events.jsonl` is the canonical bus. A future web dashboard tails it (or its replication via `inotify`/file-watcher → SSE). Out of scope for this RFC; the contract is "the file exists, it's append-only, it's schema-stable."

## 8. Schema Changes

- New `$ARTIFACTS_DIR/_orchestrator/state.json` — orchestrator-wide state (current tick, last frontier hash, configured concurrency).
- New `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` — per-worker state (resumable).
- New `$ARTIFACTS_DIR/_orchestrator/events.jsonl` — event stream.
- New `OrchestratorConfig` resource at `.ai-sdlc/orchestrator-config.yaml` — `tickIntervalSec`, `maxConcurrent` (overrides RFC-0010 default), failure-budget overrides per mode.

No changes to existing schemas — orchestrator is a consumer.

## 9. Backward Compatibility

- Opt-in via feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`. Default off.
- `/ai-sdlc execute <task-id>` continues to work unchanged for interactive use.
- `/loop /ai-sdlc execute <task-id>` continues to work as the lightweight alternative for operators who don't want a long-running process.
- When the flag is on, the orchestrator AND `/ai-sdlc execute` share the worktree pool — they don't race because the per-worktree sentinel scopes claims correctly.

Promotion path: opt-in soak, operator decides per-project when to flip default-on.

## 10. Alternatives Considered

### 10.1 GitHub Actions matrix as the orchestrator

Could fan out workflow runs (one per task) instead of building a Node process. Rejected because:
- GitHub Actions has 6h job cap; a long-running task needs to checkpoint or restart, doubling complexity.
- Concurrency is per-workflow not per-runner — coordinating N workflows via job outputs is brittle.
- Local-machine execution (which is the bulk of dogfood today) doesn't benefit.

The orchestrator described here can run inside a GH Actions job for unattended remote use, but doesn't require it.

### 10.2 Bash cron + `/loop` (status quo)

Already what we use. Doesn't handle failures deterministically — every secret-scan-block, merge-queue-race, etc. wakes up Claude in interactive mode. Status quo is the baseline this RFC improves over, not an alternative.

### 10.3 Dedicated daemon / systemd service

Considered. The Node-process-in-sandbox model wins on portability (Docker, GH Actions runner, local terminal — same code path). A `systemd` service is a deployment choice the operator makes, not a design constraint.

## 11. Implementation Plan

Sequential phases, each behind feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`.

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 1: Bare orchestrator loop** | 1 wk | Polling loop reads frontier, dispatches via `executePipeline()`, no failure recovery beyond the existing iteration loop | 5-task fixture queue drains end-to-end; 3 failure-injection tasks hit `[needs-human-attention]` |
| **Phase 2: Failure playbook** | 1.5 wk | All 8 modes from §5.1; per-mode tests with synthetic triggers | 90%+ of injected failures recover automatically; remaining 10% escalate cleanly |
| **Phase 3: Pre-dispatch filters** | 0.5 wk | DoR readiness (RFC-0011), dependency check (cli-deps), external-deps gating (RFC-0014 Q3) | Filter trace logged; `OrchestratorAwaitingExternal` event fires correctly |
| **Phase 4: Observability hooks** | 1 wk | events.jsonl writer, `cli-status --orchestrator` view, schema definition for downstream consumers | Dashboard mock can render real-time view from the event stream |
| **Phase 5: Hardening + soak** | corpus-driven, NOT calendar-gated | Real-issue queue (≥20 tasks across 3 RFCs); chaos test (kill orchestrator mid-tick, verify resume); subscription-quota burn validation | Promotion to default-on when 95%+ tasks complete without human intervention AND no quota-burn surprise |

Total wall-clock: ~4 weeks for Phase 1-4; Phase 5 is corpus-driven per maintainer directive 2026-05-01.

Critical path: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5.

## 12. Resource Sizing & Cost Model

Single sandbox, current dogfood scale:

- Avg task: dev (~10min) + 3 reviewers (~3min each parallel = ~3min) + finalize (~1min) = ~15min wall-clock
- `parallelism.maxConcurrent: 3` (RFC-0010 default for Max-20x tier)
- → ~12 tasks/hour theoretical max
- → ~96 tasks/8h overnight batch

Subscription window (Claude Code Max-20x, 5-hour rolling):

- Per task: 1 dev call + 3 reviewer calls = 4 LLM calls
- Avg ~50k tokens per call (per RFC-0010 §14.6.4 cold-start defaults)
- → ~200k tokens/task; 12 tasks/hour × 5h = 60 tasks; 60 × 200k = 12M tokens/window
- Tier limits: ~7M-15M tokens/window depending on plan
- → orchestrator MUST respect RFC-0010 §14 scheduling to avoid mid-batch quota exhaustion

This RFC explicitly delegates quota management to RFC-0010 §14 — orchestrator does not duplicate the SubscriptionLedger; it consults it via the dispatcher's "may-dispatch?" check.

## 13. Open Questions

1. **Q1: How should the orchestrator surface the "human-attention queue"?** Tasks parked at `NEEDS_HUMAN_ATTENTION` need operator visibility. Options: dedicated `cli-status --needs-attention` view, GitHub Project board column, Slack digest, or just a label query on PRs. Lean: `cli-status` view + PR label `needs-human-attention` (already used informally). Decide before Phase 4.

2. **Q2: What's the orchestrator's restart/resume semantics on crash mid-tick?** Workers persist state per §5.2; the orchestrator itself is mostly stateless (re-derives from frontier on restart). But if a worker is mid-finalization (commit pushed but PR not yet opened), how does the new orchestrator know? Lean: read `git ls-remote` for the worker's branch on startup; if branch exists but no PR, finish opening the PR. Decide before Phase 1.

3. **Q3: Does the orchestrator's "may-dispatch?" check go through the SubscriptionLedger's scheduler (RFC-0010 §14) or implement its own quota awareness?** Goes through. But what's the fallback when the ledger says "no, off-peak only" and the queue is empty during peak hours? Lean: just sleep until off-peak; emit `OrchestratorIdleWaitingForOffPeak`. Decide before Phase 3.

4. **Q4: Should the orchestrator run multiple independent failure-recovery attempts in parallel (e.g. retry secret-scan-block AND retry push-race for two different workers simultaneously)?** Lean: yes — each worker's state machine is independent; the playbook handlers are per-worker, not global. Decide before Phase 2.

5. **Q5: How does the orchestrator handle a backlog with 0 ready tasks?** Sleep tick after tick with zero work. Resource cost is minimal but the operator may want a "no work for N consecutive ticks → emit `OrchestratorIdle` and slow polling to 5min" backoff. Lean: linear backoff to 5min after 10 idle ticks. Decide before Phase 1.

6. **Q6: When the orchestrator detects that a worker's PR has been queued for merge for >2h, does it park the worker or wait?** Lean: park (release the worktree; the PR continues independently; that worker slot picks the next task). The `LongRunningPRBlocksWorker` event surfaces the pattern if it recurs. Decide before Phase 2.

7. **Q7: Should the orchestrator's failure playbook be configurable per-project (e.g. some projects might want secret-scan-block to escalate immediately rather than auto-fix)?** Lean: yes — `OrchestratorConfig.failureBudgets[mode]` overrides the defaults. Decide before Phase 4.

## 14. References

- RFC-0010 — Parallel Execution and Worktree Pooling (parallelism + scheduling foundation)
- RFC-0011 — Definition-of-Ready Gate (admission filter)
- RFC-0012 — Two-Tier Pipeline Architecture (`executePipeline()` library this orchestrator drives)
- RFC-0014 — Dependency Graph Composition (priority + DoR composition + external dependencies)
- AISDLC-105 — `/ai-sdlc rebase` (existing rebase-conflict remediation)
- AISDLC-117 — `cli-deps` (frontier + blockers + validate)
- Original conversation with @dominique establishing the need (2026-05-01): "this is mostly a deterministic operation by now ... the vision I have is a deterministic pipeline that we can spawn up processing of 10 issues concurrently per sandbox and run multiple sandboxes in parallel to burn through an issue stack."
