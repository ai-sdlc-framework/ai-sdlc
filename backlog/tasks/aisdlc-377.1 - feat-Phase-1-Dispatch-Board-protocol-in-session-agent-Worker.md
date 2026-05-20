---
id: AISDLC-377.1
title: 'feat(dispatch): RFC-0041 Phase 1 — Dispatch Board protocol + in-session-agent Worker'
status: In Progress
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0041
  - phase-1
  - dispatch-board
  - in-session-agent
  - critical
parentTaskId: AISDLC-377
dependencies: []
priority: critical
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - backlog/completed/aisdlc-353 - feat-document-subscription-only-tick-path-post-agent-sdk-credit.md
---

## Scope (RFC-0041 §4.3 + §4.4 + §7 Phase 1)

Phase 1 ships the Dispatch Board protocol + the in-session-agent Worker kind end-to-end. No supervisor, no claude-p shell-out — that's Phase 2 (AISDLC-377.3). Phase 1 is the subscription-preserving path operators can use immediately.

### Deliverables

1. **Two new JSON schema files under spec/schemas/**:
   - A dispatch-manifest v1 schema — shape per RFC §4.4 (taskId, branch, worktree, baseSha, workerKind, dispatchedAt, dispatchedBy, spec.{taskFile, model, budgetMs, verifyCommands})
   - A dispatch-verdict v1 schema — shape per RFC §4.4 (taskId, outcome, commitSha, pushedBranch, prUrl, verifications, acceptanceCriteriaMet, notes, completedAt, workerId)

2. **A new Conductor-side library under pipeline-cli/src/dispatch/**:
   - A board module exporting writeManifest(), collectVerdicts(), peekQueue(), claimNext(workerKind), releaseInflight(), sweepStaleHeartbeats()
   - Filesystem layout: .ai-sdlc/dispatch/{queue,inflight,done,failed}/ subdirectories
   - Atomic claim via fs.renameSync (POSIX-atomic on same filesystem)
   - Heartbeat read/write helpers on inflight state-tracking files

3. **A new operator-config schema** (a dispatch-config v1 schema file under spec/schemas/ + matching .ai-sdlc/ runtime config):
   - spec.defaultWorkerKind: in-session-agent | claude-p-shell (default in-session-agent)
   - spec.parallelism.{inSessionAgentMaxSessions, claudePShellMaxConcurrent}
   - spec.inSessionAgent.{pollIntervalSec, quotaBackoffSec, quotaBackoffMaxSec, quotaBackoffMultiplier}
   - spec.claudePShell.{pollIntervalSec, watchdogMs, supervisorPidFile} (read by Phase 2; declared here for forward-compat)

4. **Conductor changes to the existing /ai-sdlc orchestrator-tick slash command** (ai-sdlc-plugin/commands/orchestrator-tick.md):
   - Replace existing Agent(... run_in_background: true) dispatch with dispatch.writeManifest() calls
   - On each ScheduleWakeup tick, poll the done and failed subdirectories; fan-out reviewers for new verdicts (foreground Agent calls, within 600s budget)
   - Backpressure: if queue + inflight count ≥ inSessionAgentMaxSessions, skip emitting new manifests

5. **A new slash command /ai-sdlc dispatch-worker** (in-session-agent Worker entry point):
   - Operator opens a new CC session, fires this command
   - Slash-command body loops: claim a manifest matching workerKind ∈ {any, in-session-agent}, invoke ai-sdlc:developer foreground Agent, write verdict, ScheduleWakeup(5s)
   - Empty queue → ScheduleWakeup(30s) hibernate
   - Quota exhaustion (429) → write a quota-exhausted diagnostic to the failed subdir with retryAfter, hibernate per OQ-7 cool-down

## Acceptance criteria

- [ ] #1 The new dispatch-manifest v1 + dispatch-verdict v1 schemas published under spec/schemas/; validated by pnpm validate-schemas
- [ ] #2 The new pipeline-cli/src/dispatch/ board module exports all functions listed in Deliverable 2; atomic-claim integration test (two concurrent claim attempts on same manifest → exactly one wins, no double-pickup)
- [ ] #3 The new dispatch-config v1 schema published with operator defaults; an example config file shipped under spec/examples/
- [ ] #4 The Conductor slash command updated: polls done + failed subdirs on every tick; emits manifests when queue empty AND under concurrency cap; spawns reviewer fan-out + sign + push + arm auto-merge from done verdicts (existing finalization logic reused)
- [ ] #5 The new /ai-sdlc dispatch-worker slash command exists; loops claim → foreground Agent → verdict → ScheduleWakeup; handles empty-queue hibernation + 429 cool-down per OQ-7
- [ ] #6 Hermetic test: 3-manifest queue + 2 in-session-agent Worker sessions; verify atomic claim (no double-pickup), all 3 verdicts collected by Conductor, Workers idle when queue empties
- [ ] #7 End-to-end acceptance: this CC session as Conductor + 2 operator-opened sibling CC sessions as Workers drain 2 real frontier tasks concurrently; zero Anthropic 600s watchdog kills observed; verdicts land in the done subdir with all 4 verifications passing
- [ ] #8 New code reaches 80%+ patch coverage

## Out of scope

- Supervisor + `claude-p-shell` Worker (Phase 2 / AISDLC-377.3)
- Iteration mechanism (Phase 1.5 / AISDLC-377.2)
- `cli-deps frontier --workerKind` annotation (Phase 3.2 / AISDLC-377.5)

## Source

RFC-0041 §7 Phase 1; operator OQ-1 + OQ-2 + OQ-3 + OQ-5 + OQ-6 + OQ-7 resolutions (2026-05-20 walkthrough).
