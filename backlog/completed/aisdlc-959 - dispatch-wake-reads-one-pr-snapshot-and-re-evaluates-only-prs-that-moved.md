---
id: AISDLC-959
title: 'A dispatch wake reads one PR snapshot and re-evaluates only PRs whose head or checks moved since the last wake'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - reconciler
  - cost
dependencies: []
references:
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/human-attention.ts
  - pipeline-cli/src/hierarchy/mark-ready.ts
  - pipeline-cli/src/dispatch/webhook-receiver.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

One dispatch wake-up today makes four separate `gh pr list` calls (human-attention, mark-ready, land-eligible, reconcile), one `gh pr view` per open PR in reconcile, and about eleven calls per own PR in land-eligible, which re-runs the full eligibility read for a PR that was refused last time even when nothing about it changed. At ten open PRs that is about 130 user-token calls per wake, and the busy cadence wakes every 30 seconds. The webhook receiver already records one event per PR head and check change under the board `events/` directory, but nothing reads them: every fact is re-read over REST.

**Five-step review (requirements first).**
1. Requirement questioned: must every wake re-read every PR? No; a PR whose head, checks and review state have not produced an event since the last wake has the same answer as last time.
2. Delete: the three duplicate list calls and the unconditional per-PR eligibility read.
3. Simplify: one PR snapshot per wake shared by the four consumers; a per-PR fingerprint (head sha, last event id, check rollup) persisted on the board; land-eligible and reconcile skip any PR whose fingerprint is unchanged; landing records for a PR closed without landing expire instead of being re-checked forever.
4. Accelerate: when the webhook receiver is up, the wake consumes the recorded events to decide which PRs moved and only views those; a snapshot older than 15 minutes is refreshed regardless, so a lost delivery costs latency, not correctness.
5. Automate: a test with ten open PRs and no new events asserts one list call and zero views on the second wake; the existing receiver test asserts the event records carry what the fingerprint needs.

## Acceptance Criteria

- [ ] A wake with no new events since the last one makes at most one GitHub list call.
- [ ] A PR refused by the eligibility check is not re-read until its fingerprint changes or 15 minutes pass.
- [ ] Landing records for closed-unlanded PRs stop being re-checked after one confirmation.
- [ ] `docs/operations/cli-hierarchy.md` describes the snapshot, the fingerprint and the refresh interval.
