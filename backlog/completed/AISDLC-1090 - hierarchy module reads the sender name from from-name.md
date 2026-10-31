---
id: AISDLC-1090
title: 'hierarchy hooks module reads the sender from the cross-session envelope from-name attribute, so enqueue and rotate from dispatch are consumed instead of reaching the executor model'
status: Done
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

- [x] A test feeds `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="ai-sdlc-operator-dispatch" from-mode="bypass">enqueue AISDLC-1</cross-session-message>` to the executor receive handler and asserts the resume command runs and `next` is not called.
- [x] The same for `rotate`, and the planner handler still passes a non-dispatch sender through unchanged.
- [ ] Live check in the PR body: after relaunch, `cli-hierarchy clear <executor>` is acknowledged by the module (no "no hooks module consumed it").
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Test run note (round 2)

Round 1 reviewers flagged the unclosed describe in hierarchy.test.ts (fixed: braces closed), the from-name/from split (added `senderAddressOf`, used by `recordReceivedSender` so the AISDLC-1080 received log keeps the uds address, with a test), and the waiver. `env -i HOME=$HOME PATH=$PATH pnpm test` now exits 0 on this branch rebased onto origin/main: no waiver. (Without `env -i` the agent shell leaks variables and 15+ pipeline-cli executor-start tests fail; that is environmental.)

## Final Summary

## Summary
Hierarchy hooks module now reads the sender name from the `from-name` attribute (falling back to `from`), so enqueue from dispatch is consumed again. `senderAddressOf` keeps the raw `from` socket address for the AISDLC-1080 reply allowlist.

## Changes
- ai-sdlc-plugin/hooks/hierarchy/executor.ts
- ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
- ai-sdlc-plugin/mods/tests/hierarchy.test.ts

## Design decisions
Test command: `env -i HOME=$HOME PATH=$PATH pnpm test`; exits 0, all suites pass. rotate is no longer a message (AISDLC-1107), so the test asserts it passes through. AC3 (live `cli-hierarchy clear` check) needs a relaunch and is added to the PR body as a post-merge check.

## Verification
- `pnpm build` - passed
- `pnpm test` - passed
- `pnpm lint` - passed
- `pnpm format:check` - passed
