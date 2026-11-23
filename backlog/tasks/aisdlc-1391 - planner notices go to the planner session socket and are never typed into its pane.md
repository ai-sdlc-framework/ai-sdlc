---
id: AISDLC-1391
title: 'Planner notices go to the planner session socket and are never typed into its pane'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - hierarchy
dependencies: []
references:
  - pipeline-cli/src/hierarchy/planner-notify.ts
  - pipeline-cli/src/hierarchy/send.ts
  - pipeline-cli/src/hierarchy/escalation-file.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/cli/dispatch.ts
priority: high
---

## Description

**Gap.** Every notice to the planner (reconcile `route-to-planner` lines such as `PR #259 needs the planner: pending (head bbc4e4bc)`, red-main notices, and `Escalation for <id>: ...` from `pipeline-cli/src/hierarchy/escalation-file.ts:144`) goes through `createPlannerNotifier` in `pipeline-cli/src/hierarchy/planner-notify.ts`. It sends to a socket only when `<board>/handoff/address-<planner>.json` exists (`readPlannerAddress`), and nothing in the repository writes that file (AISDLC-1373 shipped the reader without a writer). So every notice falls back to `tmux send-keys` into the planner pane. The AISDLC-1373 guard (`composerHasText`) checks the composer and then types, which is a race: text the operator starts typing between the check and the keystrokes is interleaved with the notice and submitted.

**Failure.** Operator, 2026-11-22: notices keep being typed into the arcana-website planner chat window while they type, interrupting them. arcana-website has 1,000+ routed notices recorded in `landing/planner-routes.json`.

**Evidence the socket is derivable.** Each Claude Code session listens on `/tmp/cc-socks/<pid>.sock`, and the roster (`hierarchy.json`) already records each session's `pid`: the arcana-website planner is pid 60563 and `/tmp/cc-socks/60563.sock` exists; the same holds for its dispatch session (60962). `send.ts` already has a socket sender (`createSocketSender`) and accepts `uds:/...sock` addresses.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the operator's requirement is that a notice never lands in the composer; typing into a pane cannot meet it, however it is guarded. 2. Deleted: the tmux fallback for planner notices, the composer guard that served it, and the unwritten `address-<name>.json` lookup. 3. Simplified: the address is `uds:/tmp/cc-socks/<roster pid>.sock`, derived from the roster at send time, so there is no file to write or keep fresh. 4. Accelerated: none. 5. Automated: tests below.

- `createPlannerNotifier` derives the planner's socket from its roster `pid` and sends with the socket sender. If the socket file is missing or the send fails, it throws, so the caller keeps the item undelivered and retries on a later pass (existing contract); it never types into the pane.
- Verify the socket directory against Claude Code's actual location (honour an env override if Claude Code exposes one) and keep it in one constant.
- `cli-hierarchy status` prints one line when planner notices are being held because the socket is unreachable, with the count, so a broken channel is visible.
- Remove `readPlannerAddress`, `composerHasText` and their tests if nothing else uses them.
- Out of scope: briefs and wake commands typed into the dispatch and executor panes (no operator types there).

## Acceptance Criteria

- [ ] #1 A test: a planner notice is written to `uds:/tmp/cc-socks/<pid>.sock` for the planner's roster pid, and the pane sender is never called.
- [ ] #2 A test: with the socket missing, the notifier throws, nothing is typed, and the route stays undelivered for retry.
- [ ] #3 A test: `Escalation for ...` notices from `escalation-file.ts` use the same socket path.
- [ ] #4 `cli-hierarchy status` shows held planner notices when the socket is unreachable.
- [ ] #5 Manual check in the PR: a reconcile route reaches a live planner session as a cross-session message while text sits in its composer, and the composer text is untouched.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
