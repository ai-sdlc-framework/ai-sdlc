---
id: AISDLC-169.1
title: 'Phase 1: Bare orchestrator loop'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0015
  - phase-1
  - orchestrator
  - loop
milestone: m-3
dependencies: []
parent_task_id: AISDLC-169
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0015. Ship the bare orchestrator loop — the Node process that polls the dispatch frontier, dispatches up to `parallelism.maxConcurrent` workers via `executePipeline()`, and exits cleanly on shutdown. **No failure recovery beyond the existing iteration loop in `executePipeline()`** — Phase 2 owns the failure playbook. Estimated 1 week.

Per RFC §13 Q11 resolution: **pure Node process** at `ai-sdlc-plugin/orchestrator/run.mjs` (or similar), packaged with a systemd unit + Docker template + GH Actions self-hosted runner config so operators can pick their supervision mode. Workers go through `SubagentSpawner` (RFC-0012) — same code path as today's `/ai-sdlc execute`.

## Open-question resolutions implemented in this phase

- **Q1 (human-attention surface, layers A+B):** PR label `needs-human-attention` is the durable source of truth + `cli-status --needs-attention` view ships alongside the orchestrator's basic loop. Slack push (layer C) defers to Phase 4.
- **Q2 (resume semantics):** Stateless + idempotent finalize. Each finalize step (file move from `tasks/` → `completed/`, attestation sign, chore commit, push, PR open) checks "already done?" before doing. A crashed-mid-finalize worker is picked up on the next tick; the new orchestrator runs the same finalize sequence with each step short-circuiting where appropriate. **No resume code path; startup IS the recovery path.** §5.2 worker state file persists for forensic + observability purposes (drives `cli-status --orchestrator` view in Phase 4) but does NOT drive resume.
- **Q5 (no-work backoff foundation):** Phase 1 wires the global polling-cadence state on the orchestrator (default tick `tickIntervalSec: 30`). The exponential-backoff curve (30s → 5min cap) is plumbed in Phase 3 with the rest of the pre-dispatch admission stack; Phase 1 keeps the simple constant tick.
- **Q8 (UnknownFailureMode):** Phase 1 defines the `UnknownFailureMode` event schema + the `[needs-human-attention]` PR label semantics. The catalogue is empty in Phase 1 — every failure that escapes `executePipeline()`'s native iteration is an unknown failure and escalates. Phase 2 wires the 9-pattern catalogue.
- **Q10 (PR drift detection):** Periodic poll. Each tick runs `gh pr list --author "@me" --state open --json number,mergeStateStatus,headRefOid` and reconciles results against the worker pool. Cheap, bounded by tick interval. Webhook-driven (option B) deferred to Phase 4 only on measured pain.
- **Q11 (process model):** Pure Node process. `ai-sdlc-plugin/orchestrator/run.mjs` is the operator-managed entry point. Ship template configs for systemd + Docker + GH Actions self-hosted runner.
- **Q12 (auto-merge orchestrator side):** Finalize sequence adds an idempotent `gh pr merge --auto --rebase <pr>` call after every push and emits `AutoMergeFlagSet` to events.jsonl. Defense-in-depth with the workflow side already shipped via AISDLC-130.

## Components

- **Outer loop driver** (RFC §4.1): `loop forever { check shutdown; frontier = cli-deps frontier; dispatch up to budget; drain completed; sleep tickInterval }`. Default `tickIntervalSec: 30`.
- **Worker pool integration** (RFC §4.2): allocates worktrees via `WorktreePoolManager` (RFC-0010 §7.1), writes per-worktree `.active-task` sentinel (AISDLC-81), invokes `executePipeline()`, releases via `cleanupOnMerge` hook on completion.
- **Idempotent finalize** (Q2): each finalize step has an "already done?" predicate. Documented in `pipeline-cli/docs/orchestrator.md` (new file).
- **Periodic PR poll** (Q10): per tick, `gh pr list` reconciles open AISDLC-bot PRs against the worker pool — orphaned PRs (worker exited without finalize) flagged for the next worker to pick up; merged PRs trigger worktree cleanup.
- **Auto-merge flag setter** (Q12): finalize sequence ends with `gh pr merge --auto --rebase <pr>` (idempotent — no-op if already enabled); emits `AutoMergeFlagSet` event.
- **`cli-status --needs-attention` view** (Q1 layer B): lists open PRs with the `needs-human-attention` label sourced from `gh pr list --label needs-human-attention`.
- **Operator entry point**: `ai-sdlc-plugin/orchestrator/run.mjs` with feature-flag guard `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`. Refuses to start unless flag is set.
- **Supervision templates**: systemd unit (`ai-sdlc-plugin/orchestrator/templates/systemd/orchestrator.service`), Docker template (`ai-sdlc-plugin/orchestrator/templates/docker/Dockerfile`), GH Actions self-hosted runner config (`ai-sdlc-plugin/orchestrator/templates/github-actions/orchestrator-runner.yml`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Outer loop driver (RFC §4.1) ships at `ai-sdlc-plugin/orchestrator/run.mjs`: polls `cli-deps frontier --status "To Do"` per tick, dispatches up to `parallelism.maxConcurrent` workers via `executePipeline()` (RFC-0012 Tier 2), drains completed workers, sleeps `tickIntervalSec` (default 30s) — runs forever until SIGINT/SIGTERM
- [ ] #2 Behind feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (default off, accepts `experimental` or truthy values per RFC §9); refuses to start when flag is unset and emits a clear "set AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental to enable" error
- [ ] #3 Worker pool integration (RFC §4.2): allocates worktree via `WorktreePoolManager` (RFC-0010 §7.1), writes `.active-task` sentinel (AISDLC-81), invokes `executePipeline()` with the configured `SubagentSpawner`, releases worktree via `cleanupOnMerge` hook on completion
- [ ] #4 Q2 idempotent finalize: each finalize step (`mv tasks/*.md completed/`, attestation sign, chore commit, push, `gh pr create`) has an "already done?" predicate documented in `pipeline-cli/docs/orchestrator.md`. A crashed-mid-finalize worker resumed on the next tick produces no duplicate commits, no duplicate PRs, no duplicate file moves
- [ ] #5 Q10 periodic PR poll: per tick, runs `gh pr list --author "@me" --state open --json number,mergeStateStatus,headRefOid` and reconciles open AISDLC-bot PRs against worker-pool state. Orphaned PRs (worker exited without finalize) re-enter the worker pool for finalize completion; merged PRs trigger worktree cleanup
- [ ] #6 Q11 packaging: ships `ai-sdlc-plugin/orchestrator/run.mjs` plus three supervision templates — `templates/systemd/orchestrator.service`, `templates/docker/Dockerfile`, `templates/github-actions/orchestrator-runner.yml` — each with operator-runbook entries for installation
- [ ] #7 Q12 auto-merge orchestrator-side: finalize sequence ends with `gh pr merge --auto --rebase <pr>` (idempotent, no-op if already enabled); emits `AutoMergeFlagSet` event to `events.jsonl`
- [ ] #8 Q1 layers A+B: PR label `needs-human-attention` is the durable source of truth (orchestrator labels via `gh pr edit --add-label`); `cli-status --needs-attention` ships a list view sourced from `gh pr list --label needs-human-attention`
- [ ] #9 Q8 unknown-failure schema: `UnknownFailureMode` event type defined in the events.jsonl schema (Phase 4 ships full schema; Phase 1 stakes out this entry); any failure escaping `executePipeline()`'s native iteration in Phase 1 emits this event and tags the PR with `needs-human-attention`. Phase 1 catalogue is empty by design — Phase 2 wires the 9 patterns
- [ ] #10 Acceptance fixture: a 5-task fixture queue drains end-to-end without human intervention; 3 failure-injection tasks (one synthetic verification fail, one synthetic git push fail, one synthetic missing-reference) hit `[needs-human-attention]` cleanly with the expected event trail
- [ ] #11 Hermetic tests cover the loop driver (one tick happy path, one tick empty frontier, SIGTERM drain), worker dispatch (worktree alloc + sentinel write + executePipeline call + release), idempotent finalize (each step's "already done?" predicate verified), and PR poll reconciliation. Spawner mocked via the existing `MockSpawner` (RFC-0012)
- [ ] #12 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
