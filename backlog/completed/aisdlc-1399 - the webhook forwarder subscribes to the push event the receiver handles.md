---
id: AISDLC-1399
title: 'The webhook forwarder subscribes to the push event the receiver handles'
status: Done
assignee: []
created_date: '2026-11-23'
labels:
  - bug
  - pipeline-cli
  - hierarchy
  - webhook
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/dispatch/webhook-receiver.ts
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

**Gap.** AISDLC-1379 (#2955, merged 9a907c6e) made dispatch poll on the slow interval while the webhook is healthy, and made a default-branch `push` the wake for "main moved". The receiver accepts `push` (`pipeline-cli/src/dispatch/webhook-receiver.ts:39`, handled at `:131`), but the forwarder installs `gh webhook forward` with `FORWARD_EVENTS` (`pipeline-cli/src/hierarchy/webhook-forwarder.ts:16-17`), which lists `pull_request,check_suite,check_run,workflow_run,status,pull_request_review` and no `push`. GitHub therefore never sends a push, and after main moves dispatch waits up to the 15-minute slow interval before it reconciles. `docs/operations/cli-hierarchy.md:455-456` lists the same six kinds.

**Source.** Planner session 2026-11-23 (landed work, no dependency). Interim repair already applied on the operator's machine: the launchd plist for this board was edited to add `push` and reloaded (repo hook now has `push`). The next `cli-hierarchy webhook up` reinstalls the plist from `FORWARD_EVENTS` and drops `push` again.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the forwarder must subscribe to every kind the receiver acts on, no more. 2. Deleted: the second hand-kept event list. 3. Simplified: derive `FORWARD_EVENTS` from the receiver's accepted-kinds list (export it from `webhook-receiver.ts`) so the two cannot drift. 4. Accelerated: none. 5. Automated: a test asserts the forwarder's `--events` value equals the receiver's accepted kinds.

- Export the receiver's accepted event kinds and build `FORWARD_EVENTS` from them, so `push` is included.
- `webhook up` on a board whose installed plist lacks a kind reinstalls it (compare the plist's `--events` with `FORWARD_EVENTS`).
- Update `docs/operations/cli-hierarchy.md:455-456` to list `push` and say the list comes from the receiver.

## Acceptance Criteria

- [ ] #1 `FORWARD_EVENTS` includes `push`, and a test fails if the forwarder's events differ from the kinds the receiver accepts.
- [ ] #2 `cli-hierarchy webhook up` on a board whose installed forwarder lacks `push` reinstalls it with `push`; a test covers it.
- [ ] #3 `docs/operations/cli-hierarchy.md` lists `push` among the subscribed event kinds.
