---
id: AISDLC-1375
title: 'Webhook self-repair recovers a dropped forwarder without the operator'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - hierarchy
  - pipeline-cli
  - webhook
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook-repair.ts
  - pipeline-cli/src/hierarchy/webhook-repair.test.ts
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - pipeline-cli/src/hierarchy/webhook-health.test.ts
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

**Gap.** The `gh webhook forward` feed of this repository was dead for about 32 hours (last event 2026-11-20T15:09Z) and dispatch fell back to polling (about 2,700 gh calls an hour, DEC-0422). The self-repair added by AISDLC-1299 never recovered it, and DEC-0422 asked the operator to run the fix by hand. The operator ruled on 2026-11-22: the hierarchy must start and repair the webhook service itself and must not ask the operator to do it.

**Observed** (2026-11-22, this machine).

- `.ai-sdlc/dispatch/webhook-forward.log` (68,545 lines): 15 times `Error: error receiving json event: websocket: close 1006 (abnormal closure): unexpected EOF`, then 2,963 times `Error: error creating webhook: HTTP 422: Validation Failed ... Hook already exists on this repository`. The forwarder dies on a websocket drop, leaves its `cli` hook on GitHub, and every launchd restart (KeepAlive, `ThrottleInterval` 30) fails on that leftover hook.
- The amplified-career-site board showed the same loop (2,966 `Hook already exists` lines).
- `cli-hierarchy webhook up --feed gh-forward` fixed both at once, because `installForwarder` calls `deleteStaleCliHooks` first (`webhook-forwarder.ts:242`).
- The DEC-0422 signals had `"feed":"none"` and `"forwarder":"unknown"` while the agent `com.ai-sdlc.webhook.dispatch-8c0ee5cb` was installed and looping.

**Facts read in code** (main at ea5d9015d, paths under `pipeline-cli/src/hierarchy/`).

- `webhook-repair.ts` `eligible` returns false unless `readState(boardDir).feed` is `gh-forward` with an `agent`, and `h.signals.feed === 'gh-forward'`. A record with feed `none`, or with no `agent`, is never repaired even when this board's agent plist exists.
- `webhook-repair.ts` `run`: when the agent file is up to date it only runs `launchctl kickstart -k`. It never calls `deleteStaleCliHooks`, so a kickstart restarts straight into `HTTP 422 Hook already exists`.
- The agent's `ProgramArguments` run `gh webhook forward` directly (`renderPlist`, `webhook-forwarder.ts:99`), so nothing cleans the leftover hook when launchd restarts the job.
- `webhook-health.ts:115-117` writes "Fix (operator only; it touches your GitHub account and network)" into the decision body.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the operator needs the feed delivering events. It does not need a decision for a fault the machine can clear itself (operator ruling 2026-11-22). 2. Deleted: the operator-only fix prose and the manual `gh webhook forward` instruction in the decision body. 3. Simplified: one repair action, the same steps `webhook up --feed gh-forward` already runs (delete this repository's stale `cli` hooks, then reload the agent). 4. Accelerated: the tick repairs on the first unhealthy reading, without waiting for the decision path. 5. Automated: tests for each failure shape seen in the log.

- Every repair attempt deletes this repository's stale `cli` hooks before it kickstarts or reinstalls the agent.
- Make the agent clean up after itself on restart: either the launchd job runs a small wrapper that deletes this repository's stale `cli` hooks and then execs the real `gh webhook forward`, or the repair recognises the `Hook already exists` line in the log tail. The wrapper must live outside `~/Documents` (macOS refuses a launch agent that executes a file there: `Operation not permitted`, seen on 2026-11-22), for example under `~/Library/Application Support/ai-sdlc/`.
- `eligible` also returns true when this board's agent plist exists or its label is loaded, whatever the recorded feed says; the repair then records `feed: gh-forward` with the agent label.
- When the receiver itself is down for this board, the tick restarts it the same way `webhook up` does (one receiver per board, see AISDLC-1376).
- The decision opens only after the bounded attempts fail (`REPAIR_MAX_ATTEMPTS`) or the repair is blocked (no secret, no real gh). Its body names what was tried and the log tail, and no longer says "operator only" for a restart the machine can do.
- `docs/operations/cli-hierarchy.md`: say the webhook service is self-healing and when it escalates.

Out of scope: two boards interfering with each other (AISDLC-1376); tunnels and repository hooks.

## Acceptance Criteria

- [ ] #1 A test: an up-to-date agent with a log ending in `Hook already exists` gets its stale `cli` hooks deleted before the kickstart.
- [ ] #2 A test: a record with feed `none` but this board's agent plist present is eligible, and the repair records `gh-forward` with the agent label.
- [ ] #3 A test: after a `websocket: close 1006` exit, a restart of the agent starts without `HTTP 422` (wrapper or repair path).
- [ ] #4 A test: the decision is opened only after the attempts are used up or the repair is blocked, and its body has no "operator only" text for a restart.
- [ ] #5 `docs/operations/cli-hierarchy.md` describes the self-repair and the escalation point.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
