---
id: AISDLC-1090
title: 'hierarchy hooks module reads the sender from the cross-session envelope from-name attribute, so enqueue and rotate from dispatch are consumed instead of reaching the executor model'
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
  - bug
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - docs/operations/cli-hierarchy.md
---

## Description

First live run with the module loaded on all sessions, 2026-10-28 09:00Z to 09:20Z. `cli-hierarchy status` showed MODULE loaded on dispatch and the five executors, yet every `rotate` and `enqueue` that dispatch sent reached the executor model as a chat message; the executors replied "the hooks module normally consumes this message, it reached me, so the module is not consuming" and stayed idle at 77 queued, 0 inflight. The dispatch module logged the sender of every inbound message as `unknown`. The cross-session envelope the host delivers today is `<cross-session-message from="uds:/tmp/cc-socks/<pid>.sock" from-name="ai-sdlc-operator-dispatch" from-mode="bypass">`: `senderOf` in `ai-sdlc-plugin/hooks/hierarchy/executor.ts` reads the `from` attribute, which is now the socket path, and `DISPATCH_NAME` never matches it. Every consumer built on `senderOf` is dead: executor wake and rotate, planner status-noise filtering and dispatch forwarding, and the dispatch host's verdict and `landed` consumption. This is the actual blocker for unattended rotation and for the drain.

## Fix

**Five-step review (requirements first).** The requirement questioned is "identify the sender by the `from` attribute": the requirement is "the message came from this roster's dispatch session", and the host now states the name in `from-name` while `from` is a transport address. Deleted: the assumption that `from` is a name. Simplified: one `senderOf` that returns `from-name` when present and falls back to `from`, used by all three roles. Accelerated: executors wake within one tick again instead of waiting for a person. Automated: a fixture test with the live envelope text from this incident, so a future envelope change fails a test instead of a drain.

1. `senderOf(raw)`: prefer `from-name="..."`, fall back to `from="..."`; also accept the backslash-escaped subagent form already handled by `innerText`.
2. Add a unit test with the exact envelope above and with the old `from="ai-sdlc-operator-dispatch"` form; both must satisfy `DISPATCH_NAME`.
3. `dispatch.ts` line that logs `senderOf(raw) || 'unknown'`: log both attributes when the name is missing so the next envelope change is diagnosable from the pane.
4. `docs/operations/cli-hierarchy.md`, module sections: state the envelope shape the module depends on and the `from-name` rule.

## Acceptance Criteria

- [ ] A test feeds `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="ai-sdlc-operator-dispatch" from-mode="bypass">enqueue AISDLC-1</cross-session-message>` to the executor receive handler and asserts the resume command runs and `next` is not called.
- [ ] The same for `rotate`, and the planner handler still passes a non-dispatch sender through unchanged.
- [ ] Live check in the PR body: after relaunch, `cli-hierarchy clear <executor>` is acknowledged by the module (no "no hooks module consumed it").
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Test run note (resume round)

`env -i HOME=$HOME PATH=$PATH pnpm test` on this branch rebased onto origin/main: the earlier 16 executor-start/webhook-receiver failures did not reproduce; one failure remained, `pipeline-cli/src/dispatch/webhook-receiver.test.ts` "coalesces five check-run deliveries for one head into one wake" (expected 1 call, got 2). It fails identically with `env -i npx vitest run src/dispatch/webhook-receiver.test.ts` on the main checkout (7c11084c2, no diff from origin/main), so it is red on main and untouched by this diff (hierarchy.ts executor and its test only). Not caused by this task.
