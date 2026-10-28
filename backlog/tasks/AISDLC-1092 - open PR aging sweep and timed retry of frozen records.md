---
id: AISDLC-1092
title: 'open PR aging sweep: a PR with no state change for 6 hours is re-evaluated with fresh facts, gets one more action per head per window, and raises an age alarm in status'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/human-attention.ts
  - pipeline-cli/src/hierarchy/stall-notice.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28. The reconciler is one-shot: `reenter` runs once per head (loop guard in `pipeline-cli/src/hierarchy/reenter.ts`), a second attempt is routed to the planner, and an unchanged `landing/<pr>.json` record re-runs nothing (`reconcile.ts`, the "unchanged record" early return). Records for PRs #1652 and #1663 have carried `state: real-failure, action: reenter` since 2026-10-16 and nothing re-examined them for twelve days. The only age-based checks are the 24-hour alert for PRs with a `[needs-human-attention]` title marker (`human-attention.ts`), the inflight heartbeat and the queued-work stall notice (`stall-notice.ts`). There is no alarm for "open PR, no action, N hours", so a stranded PR is silent until a person reads the PR list.

## Fix

**Five-step review (requirements first).** The requirement questioned is "act once per head so the reconciler never loops": the loop risk was the same action re-firing every 30 seconds; the real requirement is "never the same action twice inside one window", which allows a timed retry. Deleted: the unconditional "unchanged record runs nothing" early return. Simplified: one age clock per PR (`lastActionAt`) drives both the retry and the alarm. Accelerated: a PR that was stuck on a transient (rate limit, flaky suite, dispatch down) gets a fresh evaluation within 6 hours instead of waiting for a ruling. Automated: the age alarm lives in `cli-hierarchy status` and the planner digest, so the oldest unactioned PR is always the first line a person reads.

1. `reconcile.ts`: every stored record gains `lastActionAt`, `lastActionKind`, `attempts`. The early return becomes: unchanged AND `now - lastActionAt < AGING_WINDOW` (default 6h, `AI_SDLC_PR_AGING_HOURS`). Past the window the record is re-evaluated against fresh facts; the same action may run again, `attempts` increments; after 3 attempts per head the PR is routed to the planner once with the three outcomes.
2. `reenter.ts`: the once-per-head guard accepts a `--window-elapsed` flag the reconciler sets when the window is past.
3. New `pr-aging.ts`: list open PRs with `now - max(updatedAt, lastActionAt) > AGING_WINDOW`; `cli-hierarchy status` prints `aging PRs: #n (Xh, lane, last action)` sorted oldest first; `cli-decisions operator-digest` includes the same list.
4. Tests: a record older than the window is re-evaluated; a record inside the window is not; attempts cap routes once; the status line sorts oldest first.
5. `docs/operations/cli-hierarchy.md`: reconciler section gains "Aging and retry".

## Acceptance Criteria

- [ ] A `landing/<pr>.json` record with `lastActionAt` 7h ago and unchanged facts is re-evaluated and its action re-run; one 1h old is not.
- [ ] After three attempts on one head the reconciler routes one line to the planner and stops retrying that head.
- [ ] `cli-hierarchy status` lists every open PR older than the window with its age, lane and last action, oldest first.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
