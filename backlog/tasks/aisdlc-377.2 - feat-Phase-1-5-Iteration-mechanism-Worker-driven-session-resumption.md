---
id: AISDLC-377.2
title: 'feat(dispatch): RFC-0041 Phase 1.5 — Iteration mechanism (Conductor-triggered, Worker-driven session resumption)'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0041
  - phase-1.5
  - iteration
  - context-preservation
parentTaskId: AISDLC-377
dependencies:
  - AISDLC-377.1
priority: high
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
---

## Scope (RFC-0041 §10 OQ-4 resolution)

Implements the iterate-dev case per RFC-0041 OQ-4: **iteration is a continuation, not a restart**. The Conductor signals "iterate" but the Worker resumes with its full prior conversation state — preserving the "what I tried and why it failed" context that makes iteration valuable.

### Deliverables

1. **Manifest schema additions** (`spec/schemas/dispatch-manifest.v1.schema.json` evolves to v1.1 — additive, backward-compat):
   - `iterationsAttempted: number` (default 0, incremented per Worker resume)
   - `iterationBudget: number` (default 2 per RFC-0015 §5; configurable per task)
   - `lastSessionId: string | null` (set by Worker on first attempt completion; consumed by Worker on resume)

2. **Iteration trigger protocol** — Conductor writes `inflight/<id>.resume.json` with `{feedback: <stderr or reviewer-major>, triggeredAt}` instead of removing the inflight manifest. The active Worker (or supervisor-spawned successor) picks up the resume signal on its next poll.

3. **Worker-side resumption (in-session-agent kind)**: the Worker's slash-command-body loop, on next ScheduleWakeup tick, checks for `inflight/<currentTaskId>.resume.json`. If present, invokes `Agent` with `continue: true` semantics (same agent subtype, same thread state from prior invocation, prepended with the Conductor's feedback). On success, writes verdict with `iterationsAttempted: 2`.

4. **Worker-side resumption (claude-p-shell kind)**: the supervisor captures the Worker's session ID before exit (via `claude -p --session-id <uuid>` flag at spawn time + parsing). On resume signal, supervisor re-spawns with `env -u CLAUDECODE claude -p --resume <session-id> "<conductor-feedback-text>"`. `claude -p` natively supports session resumption, preserving the prior conversation transcript without re-bootstrap.

5. **Conductor's done-pickup logic** — when a verdict carries `outcome: iterate-needed`, the Conductor (not the Worker) decides whether to trigger resume (within budget) or escalate to `[needs-human-attention]`. On trigger: write `inflight/<id>.resume.json` + leave manifest in `inflight/` (the Worker still owns it).

6. **Budget enforcement** — at `iterationsAttempted == iterationBudget`, the verdict's `outcome` is `iteration-exhausted`; Conductor writes a `failed/<id>.diagnostic.json` with `cause: iteration-budget-exhausted` and stops triggering resumes.

## Acceptance criteria

- [ ] #1 Manifest schema v1.1 adds `iterationsAttempted`, `iterationBudget`, `lastSessionId` fields (backward-compat — default values match v1.0 behavior)
- [ ] #2 `dispatch.writeResumeSignal(taskId, feedback)` and `dispatch.readResumeSignal(taskId)` helpers in `pipeline-cli/src/dispatch/board.ts`
- [ ] #3 in-session-agent Worker (slash-command-body loop) detects `inflight/<id>.resume.json` and invokes `Agent` with `continue: true` semantics; verdict writes `iterationsAttempted: N+1`
- [ ] #4 claude-p-shell supervisor captures session ID at spawn time and re-spawns with `--resume <session-id> "<feedback>"` on resume signal
- [ ] #5 Conductor's done-pickup logic triggers resume on `outcome: iterate-needed` within budget; emits `iteration-exhausted` failed/ entry past budget
- [ ] #6 Hermetic test: fixture verifier-fail on first attempt → resume signal written → Worker resumes → verdict on second attempt with `iterationsAttempted: 2`
- [ ] #7 Hermetic test: budget exhaustion → `failed/<id>.diagnostic.json` written with `cause: iteration-budget-exhausted`; Conductor does NOT trigger third resume
- [ ] #8 End-to-end acceptance: a real frontier task with a verifier issue gets ONE successful iteration (context preserved, second attempt benefits from first attempt's exploration) and lands a PR
- [ ] #9 New code reaches 80%+ patch coverage

## Out of scope

- Reviewer-fail iteration (RFC-0015 §5 `ReviewerMajorOrCritical` — already in scope for `iterate-needed` outcome, but the reviewer-spawn part stays Conductor-side per Phase 1)
- Multi-iteration (>2 budget) — RFC-0015 §5 caps at 2; this task honors that cap
- Cross-Worker-kind resumption (in-session-agent first attempt → claude-p-shell resume) — not supported; resumption is same-kind

## Source

RFC-0041 OQ-4 resolution per 2026-05-20 operator walkthrough: "Conductor-initiated but worker driven — the worker should be re-awoke with the same context that it had during development to do another developer iteration with the context from the conductor."
