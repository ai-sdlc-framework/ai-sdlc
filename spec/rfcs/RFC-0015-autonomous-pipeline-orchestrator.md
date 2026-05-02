---
id: RFC-0015
title: Autonomous Pipeline Orchestrator
status: Draft
lifecycle: Ready for Review
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
**Lifecycle:** Ready for Review
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-05-01
**Updated:** 2026-05-01
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [x] Engineering owner — dominique@reliablegenius.io (2026-05-02)
- [ ] Product owner — Alex (pending)
- [x] Operator owner — dominique@reliablegenius.io (2026-05-02)

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
| `StackedPRBaseSquashed` | A previously-opened PR's `mergeStateStatus` flips to `DIRTY` AND the base PR was squash-merged (detect via `gh pr view <base-pr> --json state,mergedAt` returns `MERGED` AND main has a recent squash commit overlapping the chain's content) | `git fetch origin main && git rebase origin/main` — git's `--reapply-cherry-picks` correctly skips the squashed-out commits; `--force-with-lease` push | 1 | Manual review if rebase conflicts. Alt: open a fresh PR from the rebased branch with base=main, drop the stacked chain. **Empirical evidence**: AISDLC-128 PR #157 hit this when AISDLC-126 PR #154 squash-merged. |

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

1. **Q1: How should the orchestrator surface the "human-attention queue"?** Tasks parked at `NEEDS_HUMAN_ATTENTION` need operator visibility. Options: dedicated `cli-status --needs-attention` view, GitHub Project board column, Slack digest, or just a label query on PRs. Lean: `cli-status` view + PR label `needs-human-attention` (already used informally). Decide before Phase 4. **Resolution (2026-05-01):** Option E — three layers: PR label `needs-human-attention` is the durable source of truth (anything else can be rebuilt from `gh pr list --label needs-human-attention`); `cli-status --needs-attention` is the operator's local landing page integrated with existing in-flight worker views; Slack push is the optional vigilance layer backed by the `events.jsonl` consumer (no separate code path). Phasing: A+B (label + cli-status) ship in Phase 1 alongside the orchestrator's basic loop; Slack push ships in Phase 4 with the rest of the observability surface.

2. **Q2: What's the orchestrator's restart/resume semantics on crash mid-tick?** Workers persist state per §5.2; the orchestrator itself is mostly stateless (re-derives from frontier on restart). But if a worker is mid-finalization (commit pushed but PR not yet opened), how does the new orchestrator know? Lean: read `git ls-remote` for the worker's branch on startup; if branch exists but no PR, finish opening the PR. Decide before Phase 1. **Resolution (2026-05-01):** Option D — stateless + idempotent finalize. Each finalize step (file move from `tasks/` → `completed/`, attestation sign, chore commit, push, PR open) becomes idempotent: it checks "already done?" before doing. A crashed-mid-finalize worker just gets picked up on the next tick; the new orchestrator runs the same finalize sequence, each step short-circuits where appropriate. No resume logic. No state files to corrupt. No special crash-recovery code path — startup IS the recovery path. Phase 1 must define the per-step idempotency check (e.g. `mv` skips if file already in `completed/`; `git commit` skips if HEAD already contains the chore message; `gh pr create` skips if a PR with the same head ref exists). Cost is bounded by `parallelism.maxConcurrent` (3-10 workers) × ~5 finalize steps × ~sub-second API calls = negligible. The §5.2 worker state file persists for forensic + observability purposes (per Q1's `cli-status --orchestrator` view) but does NOT drive resume — the canonical state-of-the-world is git + gh.

3. **Q3: Does the orchestrator's "may-dispatch?" check go through the SubscriptionLedger's scheduler (RFC-0010 §14) or implement its own quota awareness?** Goes through. But what's the fallback when the ledger says "no, off-peak only" and the queue is empty during peak hours? Lean: just sleep until off-peak; emit `OrchestratorIdleWaitingForOffPeak`. Decide before Phase 3. **Resolution (2026-05-01):** Option B — sleep with exponential backoff capped at 5min. Start at the configured `tickIntervalSec` (default 30s), double after each idle tick (`OrchestratorIdleWaitingForOffPeak` event), cap at 5min. Reset to base interval immediately when the ledger transitions to allowing dispatch (off-peak begins) OR when a new task lands in `backlog/tasks/` (the next non-idle tick). Rationale: a long peak (8h workday at 30s tick = 960 redundant frontier+ledger calls) generates events.jsonl noise that buries real signal; the 5min cap means at-most-5min-latency from "off-peak starts" to "first dispatch" which is rounding error against typical multi-hour off-peak windows. The latency cost is bounded; the noise reduction is substantial. Phase 3 must define the backoff state on the orchestrator (not per-worker — it's a global polling-cadence concern).

4. **Q4: Should the orchestrator run multiple independent failure-recovery attempts in parallel (e.g. retry secret-scan-block AND retry push-race for two different workers simultaneously)?** Lean: yes — each worker's state machine is independent; the playbook handlers are per-worker, not global. Decide before Phase 2. **Resolution (2026-05-01):** Option A — parallel per-worker remediation. Each worker operates on its own worktree + branch (RFC-0010 §7) and the remediation handlers (rebase, secret-scan reformat, push-retry) are scoped to that worker's branch. There's no cross-worker shared state to race on — the file-based merge gate (RFC-0010 §10.1) already handles the only legitimate global serialization (push-to-main ordering). **Phase 2 implementation MUST review every new handler for hidden global-state mutations** (e.g. an overly-clever handler that increments `OrchestratorConfig.failureBudgets[mode]` would race); add per-mode locks (Option C) only if such a case surfaces. v1 default is parallel-no-lock.

5. **Q5: How does the orchestrator handle a backlog with 0 ready tasks?** Sleep tick after tick with zero work. Resource cost is minimal but the operator may want a "no work for N consecutive ticks → emit `OrchestratorIdle` and slow polling to 5min" backoff. Lean: linear backoff to 5min after 10 idle ticks. Decide before Phase 1. **Resolution (2026-05-01):** Option B — share Q3's exponential-backoff curve (30s base, double per idle tick, 5min cap). Same mechanism, same knob, same observability surface. Both Q3 (peak-blocked) and Q5 (no-work) are "no dispatch reason" cases; the cause distinction lives in the EVENT TYPE (`OrchestratorIdleNoWork` vs `OrchestratorIdleWaitingForOffPeak`) not in separate cadence logic. Operator can grep events.jsonl by type if forensic distinction is needed. Note: Q11=A (Node process) means subscription cost is zero either way; the backoff justification is purely events.jsonl noise reduction.

6. **Q6: When the orchestrator detects that a worker's PR has been queued for merge for >2h, does it park the worker or wait?** Lean: park (release the worktree; the PR continues independently; that worker slot picks the next task). The `LongRunningPRBlocksWorker` event surfaces the pattern if it recurs. Decide before Phase 2. **Resolution (2026-05-01):** Option A — park after 2h, no further action (no auto-rebase, no escalation timer). The orchestrator's job is dispatch + recovery, not nagging. Releasing the slot keeps throughput up; the `LongRunningPRBlocksWorker` event provides the forensic signal if patterns emerge. Auto-rebase (Option B) was rejected because force-pushing during human review would dismiss reviews + auto-merge enablement (see Q12). Long-stall PRs become an operator/CI concern, not an orchestrator concern. Composes with Q12: parked PRs that had auto-merge enabled at push time will merge on their own once required checks pass.

7. **Q7: Should the orchestrator's failure playbook be configurable per-project (e.g. some projects might want secret-scan-block to escalate immediately rather than auto-fix)?** Lean: yes — `OrchestratorConfig.failureBudgets[mode]` overrides the defaults. Decide before Phase 4. **Resolution (2026-05-01):** Option A — per-project YAML config at `.ai-sdlc/orchestrator-config.yaml` carries `failureBudgets: { SecretScanBlocked: { budget: 2, escalateImmediately: false }, ... }`. The §5.1 defaults ship as the catalogue; operators override per-project. Same convention as RFC-0011's `dor-config.yaml`. Decision rejected the global "escalate everything" escape (any such intent can be expressed by setting all per-mode budgets to 0).

8. **Q8: How does the orchestrator handle a failure that doesn't match any catalogued pattern (an "unknown failure mode")?** The §5.1 playbook covers 8 known modes via stderr-string and exit-code matching. A novel failure (new GitHub error message, new pre-commit hook, new git error class) won't match any catalogue entry. Two options: (A) **Conservative fall-through** — emit an `UnknownFailureMode` event, tag the PR `[needs-human-attention]`, do NOT attempt remediation. Bias toward escalation over autonomous action on novel failures; the operator reviews and expands the catalogue if it's a recurring pattern. (B) **Categorization heuristics** — try to infer mode from stderr keywords (e.g., `ENOENT` → env, `FAIL` + test name → real verification failure). More autonomous, more risk of miscategorization. **Resolution (2026-05-01):** Option A. Mis-categorizing an env failure as a real verification failure would re-spawn the dev with stderr feedback and waste an iteration on a problem the dev can't fix. Mis-categorizing a real failure as env and using `--no-verify` would silently bypass the gate. Both directions of error are bad. Conservative fall-through with operator-driven catalogue growth keeps the playbook honest. Phase 1 must define the `UnknownFailureMode` event schema + the `[needs-human-attention]` PR label semantics; the catalogue itself grows via Q9.

9. **Q9: How are failure-detection patterns versioned + extended?** The §5.1 patterns (e.g. `push declined due to repository rule violations` for `SecretScanBlocked`) should NOT be hardcoded in TypeScript — operators need to extend them as upstream tools change error messages or as new failure modes are discovered. Lean: a versioned config file at `.ai-sdlc/orchestrator-failure-patterns.yaml` with regex per pattern + per-mode metadata (mode name, remediation handler, retry budget). Each entry PR-reviewable; orchestrator startup validates the config against a JSON Schema. Drift in upstream tools (e.g. GitHub renames an error message) requires only a config PR, not an orchestrator release. The 8 known modes from §5.1 ship as the default catalogue committed to the repo; operators can override or extend per-project. Decide before Phase 2 ships (the playbook can't be implemented without the pattern source-of-truth pinned down). **Resolution (2026-05-01):** Adopted as stated. `.ai-sdlc/orchestrator-failure-patterns.yaml` is the single source of truth; orchestrator startup validates against `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json`. Phase 2 ships the 9 default patterns from §5.1 (8 original + `StackedPRBaseSquashed` from the post-iteration addition) as the committed default catalogue; per-project overrides extend or replace.

10. **Q10: When does the orchestrator detect new conflicts on PRs it already opened?** Today's `/loop /ai-sdlc execute` model + the cron-tick "Resolve PR conflicts" step both rely on the operator (or the cron driver) waking the orchestrator to re-scan PR state. Between waking events, a PR can flip from clean → DIRTY (sibling merged into same files; base PR was squash-merged per §5.1's `StackedPRBaseSquashed`; force-push to main rebased the world) and the orchestrator won't notice for tick-interval seconds. Two options: (A) **Periodic poll** — every tick, scan all open AISDLC bot PRs via `gh pr list --json number,mergeStateStatus`. Cheap (single API call, ~50 PRs returned), naturally bounded by tick interval. (B) **Webhook-driven** — subscribe to GitHub `pull_request` + `status` webhooks; react in real-time. Lower latency, much higher complexity (webhook receiver, auth, replay-on-restart). Lean: A. Phase 1 ships with the periodic poll using the existing `gh pr list` + `gh pr view` calls; webhook-driven (B) is a Phase 4 observability optimization if poll latency becomes a real bottleneck. Decide before Phase 1. **Resolution (2026-05-01):** Option A — periodic poll. Phase 1 wires `gh pr list --author "@me" --state open --json number,mergeStateStatus,headRefOid` per tick (cheap, bounded). Webhook-driven (B) deferred to Phase 4 only if measurement shows the poll latency causes real operator pain.

11. **Q11: Implementation harness — what process actually runs the orchestrator loop?** §4.1 quietly assumes "Node process in operator's sandbox" but doesn't justify this against alternatives. The choice has major cost implications: a `/loop`-driven Claude Code session orchestrator pays ~5-15k subscription tokens per wake just for context-load (during a long peak window with 30s tick = ~300 wakes × 10k = ~3M tokens of pure idle cost), while a Node process pays zero subscription tokens for idle polling (the polling calls are `gh`/git, not LLM). This decision must be settled before Phase 1 because it propagates through Q3 (peak-blocked sleep cadence), Q5 (empty-queue sleep cadence), Q6 (long-running PR park), and §12's resource-sizing model.

   Options:
   - **(A) Pure Node process** — operator runs `node orchestrator.js` once (locally, in Docker, or on a self-hosted GH Actions runner). The Node process polls + manages workers; workers (the LLM dispatch boundary) ARE Claude Code subagents via the existing `SubagentSpawner` (RFC-0012). Idle polling: zero subscription cost. Operator burden: process supervision (systemd / pm2 / Docker restart policy).
   - **(B) `/loop`-driven Claude Code session** — operator types `/loop 30s /ai-sdlc orchestrate`; each tick wakes a Claude Code session that does one iteration of the outer loop. Idle polling cost: ~5-15k tokens per wake. Operator burden: zero — same UX they already use. Bounded by Claude Code's `/loop` mechanism.
   - **(C) GitHub Actions cron-driven** — `.github/workflows/orchestrator-tick.yml` on `schedule:` cron. Each invocation is a fresh runner that does one tick + exits. Idle cost: zero subscription tokens (consumes GH Actions minutes instead). Operator burden: workflow file maintenance. Limitations: 6h runner cap forces long-running work into multi-tick batches; harder to debug; slow startup per tick.
   - **(D) Hybrid: GH Actions cron triggers Node process; runs N polling rounds then exits** — combines C's zero-idle-cost + A's "real loop" benefit. Each cron fire spins up a runner that does multiple polling rounds within a bounded window then exits cleanly. Worker dispatch + state checkpointing must survive the exit/restart cadence (fits the Q2 idempotent-finalize design).

   **Resolution lean: A (pure Node process).** Zero idle subscription cost, simplest single-process mental model, no CI infrastructure to maintain. The "operator burden" of process supervision is one `systemd` unit or one `docker run --restart` flag — minimal. C's zero-cost is appealing but the GH Actions complexity (workflow auth, secrets, runner startup) outweighs the supervision savings for a single-developer dogfood loop. B is the easiest to start with but bleeds subscription quota during peak windows; we'd be paying real money to do nothing. D is the most clever but adds operational moving parts (GH Actions + Node) for marginal benefit over A.

   **Counter-argument: B (`/loop`)** has the lowest barrier — zero new infrastructure, operator just uses the workflow they already know. For dogfood / single-developer use, the simplicity wins even if quota is wasted; the wasted tokens are visible (operator sees their context-window usage in real-time) and the operator can stop the `/loop` if they care.

   Decide before Phase 1. The chosen harness shapes ALL of Q3/Q5/Q6/§12. **Resolution (2026-05-01):** Option A — pure Node process. Phase 1 ships `node ai-sdlc-plugin/orchestrator/run.mjs` (or similar location) as the operator-managed entry point, packaged with a systemd unit + Docker image template + GH Actions self-hosted runner config so operators can pick their supervision mode. Workers (the LLM dispatch boundary) go through `SubagentSpawner` per RFC-0012 — same code path as today's `/ai-sdlc execute`. **Side-effect on prior questions**: Q3's "5min cap" and Q5's "backoff" rationales drop the subscription-cost argument (polling is now zero-cost) — the resolutions stand but on observability/noise grounds only, not cost. §12's resource-sizing model can be tightened: idle ticks consume 0 subscription tokens; only worker dispatches (dev + 3 reviewers) burn the window.

12. **Q12: Should the orchestrator enable GitHub auto-merge on every PR it opens?** Today the `auto-enable-auto-merge.yml` workflow fires only on `pull_request: opened` — every subsequent force-push (rebase, attestation re-sign, conflict resolution) silently dismisses GitHub's auto-merge enablement, and the workflow doesn't re-fire on `synchronize` events. Result: PRs the orchestrator manages sit in a "BLOCKED waiting for human merge" state long after they're actually mergeable. **Important nuance**: enabling auto-merge is NOT the same as merging. `gh pr merge --auto` sets a flag that GitHub uses to merge once required checks pass + bot approval is valid; the merge actor is GitHub, not the orchestrator. Setting the flag is fine per CLAUDE.md's "never merge PRs" rule (the rule is about the actor, not the configuration). Three options: (A) **Orchestrator sets the flag after every push** — Phase 1 adds a `gh pr merge --auto --rebase <pr>` call to the finalize sequence (idempotent — no-op if already enabled). (B) **Fix the existing workflow** — extend `.github/workflows/auto-enable-auto-merge.yml`'s trigger from `[opened]` to `[opened, synchronize, reopened]`. Operationally cleaner (no orchestrator change), but the workflow only fires for the `pull_request` event, not for force-pushes that bypass it (rare). (C) **Both A and B** — defense in depth. Lean: C. The workflow fix (B) handles the common synchronize case; the orchestrator-side call (A) catches edge cases and provides observability into auto-merge state via the events.jsonl. Decide before Phase 1. **Resolution (2026-05-01):** Option C — both. **Workflow side (B) SHIPPED via AISDLC-130** (PR #161): trigger extended to `[opened, synchronize, reopened]`; CLAUDE.md updated with the policy distinction; gh CLI's `--auto` verified naturally idempotent (no wrapper needed). **Orchestrator side (A) is Phase 1 to-do**: finalize sequence adds `gh pr merge --auto --rebase <pr>` after every push, emits `AutoMergeFlagSet` event to events.jsonl. Defense-in-depth captures the rare edge cases the workflow misses (force-push from a worktree the workflow can't see, restart-recovery, branch-protection edits mid-flight).

## 14. References

- RFC-0010 — Parallel Execution and Worktree Pooling (parallelism + scheduling foundation)
- RFC-0011 — Definition-of-Ready Gate (admission filter)
- RFC-0012 — Two-Tier Pipeline Architecture (`executePipeline()` library this orchestrator drives)
- RFC-0014 — Dependency Graph Composition (priority + DoR composition + external dependencies)
- AISDLC-105 — `/ai-sdlc rebase` (existing rebase-conflict remediation)
- AISDLC-117 — `cli-deps` (frontier + blockers + validate)
- Original conversation with @dominique establishing the need (2026-05-01): "this is mostly a deterministic operation by now ... the vision I have is a deterministic pipeline that we can spawn up processing of 10 issues concurrently per sandbox and run multiple sandboxes in parallel to burn through an issue stack."
