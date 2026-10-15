---
id: AISDLC-918
title: 'feat(hierarchy): up owns receiver, forwarder and scheduler - one wake-file name, gh webhook forward as the default forwarder (RFC-0054 OQ-15)'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [rfc-0054, phase-1, dispatch, webhook]
dependencies: [AISDLC-880, AISDLC-829]
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - pipeline-cli/src/dispatch/webhook-receiver.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/scheduler.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Context

RFC-0054 OQ-15 (resolved 2026-10-15) chose `gh webhook forward`, owned by `cli-hierarchy up`, as the default way GitHub reaches the laptop-local receiver, with the forwarder a configuration value. The audit that led to it found three gaps in what AISDLC-880 and AISDLC-829 shipped: the receiver touches `<board>/wake` (`pipeline-cli/src/dispatch/webhook-receiver.ts`, `WAKE_FILE`) while the scheduler watches `<board>/.reconcile-wake` (`pipeline-cli/src/cli/dispatch.ts`), so a delivery never triggers a reconcile; nothing launches `cli-dispatch reconcile --watch`; and the exposure choice lived only in `docs/operations/cli-hierarchy.md`. With the secret set today an operator gets event records and nothing else.

## Fix

**Five-step review (requirements first).** Requirement questioned: "the operator runs a tunnel and registers a repository webhook by hand". No: `gh` can create, forward and remove the hook with the auth every session already holds, and the receiver's lifetime equals the session's (OQ-8). Deleted: the second wake-file name, and the hand-started scheduler. Simplified: one constant for the wake file, exported by the scheduler and imported by the receiver. Accelerated: a delivery reaches reconcile within the 2 s debounce instead of the 60 s timer. Automated last: `up` starts and `down` stops the three processes.

1. One wake-file name. Export the constant from the scheduler module and import it in the receiver; delete `WAKE_FILE` from the receiver. A test asserts the receiver's touch path equals the scheduler's watch path. Correct `docs/operations/cli-hierarchy.md` (the `webhook` section says `wake`, the scheduler section says `.reconcile-wake`).
2. Forwarder. `cli-hierarchy webhook up` starts `gh webhook forward --repo <owner>/<repo> --events <kinds> --url <the receiver URL: bind, port and path from config> --secret $AI_SDLC_WEBHOOK_SECRET` as a supervised child when the forwarder setting is `gh`, records its pid next to the receiver's in `<board>/webhook.json`, and does nothing when it is `external`. `webhook down` stops it. The event kinds come from the receiver's kind table, not a second list. Refuse with a clear message when the `gh webhook` extension is missing or the token cannot create hooks.
3. Scheduler. `cli-hierarchy up` starts `cli-dispatch reconcile --watch` when the webhook is on; `down` stops it; `status` reports `scheduler: up (pid)` or `off`.
4. Configuration. Read port, bind, path, forwarder and wake file from the RFC-0054 `PrLifecycle` config where AISDLC-878 has landed it; until then from one defaults object in `pipeline-cli/src/hierarchy/webhook.ts`, never a literal at a call site.

## Acceptance Criteria

- [ ] A test imports both modules and asserts the receiver touches exactly the path the scheduler watches; `grep -rn "'wake'" pipeline-cli/src` finds no second name.
- [ ] With the secret set and forwarder `gh`, `webhook up` spawns the forwarder and `webhook.json` holds both pids; `webhook down` stops both and the forwarder's hook is removed (test with a fake `gh` on PATH that records its argv).
- [ ] With forwarder `external`, `webhook up` starts only the receiver and prints the URL to register.
- [ ] `cli-hierarchy up` with the secret set starts the scheduler; `status` shows it; `down` stops it (hermetic test with a fake scheduler command).
- [ ] `docs/operations/cli-hierarchy.md` names one wake file, documents the forwarder setting and the three-process lifetime, and no longer prescribes a tunnel product.
- [ ] The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate).
