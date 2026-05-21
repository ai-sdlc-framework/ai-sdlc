---
id: AISDLC-377.3
title: 'feat(dispatch): RFC-0041 Phase 2 — Supervisor + claude-p-shell Worker (headless path)'
status: Done
assignee: []
created_date: '2026-05-20'
updated_date: '2026-05-20'
labels:
  - rfc-0041
  - phase-2
  - supervisor
  - claude-p-shell
  - headless
parentTaskId: AISDLC-377
dependencies:
  - AISDLC-377.1
priority: high
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
---

## Scope (RFC-0041 §4.3.2 + §4.5 + §7 Phase 2)

Phase 2 adds the **`claude-p-shell` Worker kind** + the **supervisor daemon** that spawns it. This is the headless / CI path — operators who don't keep `in-session-agent` sessions open use this. Cost-bearing (Agent SDK credit pool post-2026-06-15), so Conductor surfaces a projected cost when emitting `claude-p-shell` manifests.

### Deliverables

1. **A new supervisor daemon bin under pipeline-cli/bin/** (~150 LOC target):
   - Tiny Node daemon (per OQ-1: lives in the pipeline-cli bins, NOT a separate package)
   - Polls the dispatch queue subdir every claudePShell.pollIntervalSec (default 15s per OQ-6 cost-first bias)
   - For each manifest with workerKind ∈ {claude-p-shell, any}: atomic-rename to the inflight subdir, spawn an env -u CLAUDECODE claude -p subprocess (per RFC §4.4 environment isolation)
   - Concurrency cap: claudePShellMaxConcurrent from the dispatch-config
   - Stale-heartbeat sweeper: any inflight manifest with lastHeartbeat > 30 min ago (per OQ-3) → kill PID + move to failed subdir with cause: stale-heartbeat
   - A supervisor PID file inside .ai-sdlc/dispatch/; refuse to start if live PID already exists
   - Inherits operator env (per OQ-2): no new auth mode

2. **pnpm scripts in root package.json**:
   - supervisor:start → invokes the new supervisor bin
   - supervisor:status → reads PID file + signals 0 to check liveness; prints stats (inflight count, queue depth)
   - supervisor:stop → reads PID, kill -TERM, waits, force-kill if needed

3. **A new operator install runbook under docs/operations/**:
   - macOS launchd plist template
   - Linux systemd --user unit template
   - Manual tmux pane recipe
   - Troubleshooting (stale PID, log inspection, restart procedure)

4. **Conductor cost-warning UX** — when Conductor emits the first manifest with workerKind: claude-p-shell (or any that gets claimed by shell) in a session:
   - Print a one-line cost notice naming the post-2026-06-15 Agent SDK credit pool draw with an estimate per task from the rolling cost ledger
   - Estimate computed from the existing cost-governance module under pipeline-cli/src/ (search for the cost-governance source)
   - Suppressible via a dispatch-config suppressCostWarning flag

5. **Failure modes** per RFC §5.2:
   - WorkerSupervisorMissing (Conductor side): queue manifests accumulating + no live PID → AskUserQuestion to operator
   - WorkerSpawnRefused (supervisor side): claude -p exits immediately non-zero → failed-diagnostic written with cause: spawn-rejected
   - WorkerStaleHeartbeat: per OQ-3 sweep above

## Acceptance criteria

- [x] #1 The new supervisor bin exists under pipeline-cli/bin/, ≤200 LOC, registered in pipeline-cli's package.json bin section
- [x] #2 Supervisor performs atomic rename for claim (test: 2 concurrent spawn attempts → exactly one wins)
- [x] #3 PID file management: refuses second start when first is live; supervisor:stop cleans up gracefully
- [x] #4 Stale heartbeat sweep fires at 30-min threshold per OQ-3; SIGTERM Worker; manifest moves to failed subdir
- [x] #5 env -u CLAUDECODE confirmed before spawn (test: spawn under CLAUDECODE=1 env, child process sees it unset)
- [x] #6 The new docs/operations/ install runbook published with launchd plist + systemd unit + manual recipe
- [x] #7 Conductor cost-warning fires on first claude-p-shell manifest emission per session; uses rolling cost ledger
- [x] #8 Hermetic test: 3-manifest queue + supervisor with mock spawn (subprocess stub) → 3 verdicts collected, supervisor concurrency cap respected
- [x] #9 End-to-end acceptance: supervisor running in tmux pane (operator-started); Conductor in separate CC session emits claude-p-shell manifest; PR lands; supervisor process count returns to 0 — **operator-verified post-merge** (per dispatch brief: hermetic test covers spawn protocol; real E2E deferred to operator soak)
- [x] #10 New code reaches 80%+ patch coverage (actual: supervisor.ts 95.86%, cost-estimate.ts 100%, pid-lock.ts 93.18%, dispatch-supervisor.ts CLI 98.29%)

## Out of scope

- `cli-deps frontier --recommendedWorkerKind` annotation (Phase 3.2 / AISDLC-377.5)
- Deprecating `--spawner claude-cli` (Phase 3.1 / AISDLC-377.4)
- Multi-host supervisor (deferred per OQ-5)

## Source

RFC-0041 §7 Phase 2; operator OQ-1 (supervisor packaging) + OQ-2 (auth inherit) + OQ-3 (30 min heartbeat) + OQ-6 (15s shell poll for cost-first bias) resolutions (2026-05-20).
