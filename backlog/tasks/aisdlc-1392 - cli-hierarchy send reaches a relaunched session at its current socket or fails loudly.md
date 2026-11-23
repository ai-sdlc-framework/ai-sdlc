---
id: AISDLC-1392
title: 'cli-hierarchy send reaches a relaunched session at its current socket or fails loudly'
status: In Progress
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - hierarchy
dependencies:
  - AISDLC-1391
references:
  - pipeline-cli/src/hierarchy/send.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/registry.ts
  - pipeline-cli/src/hierarchy/brief-notify.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
priority: high
---

## Description

**Gap.** Each Claude Code session listens on `/tmp/cc-socks/<pid>.sock`. When a session is relaunched it gets a new pid, so the old address dies. Nothing in the send path notices, and a stale address loses the message silently:

1. `checkSendTarget` (`pipeline-cli/src/hierarchy/send.ts:65-83`) accepts `--to uds:/...sock` if the address appears in `<board>/handoff/received-*.json`. It never checks that the socket exists or maps the address back to a session.
2. The received log (`recordReceivedSender`, `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts:134-149`) appends raw `from` addresses, keeps the newest 50 and never drops dead ones. After a relaunch the dead address stays accepted, and the live one is accepted only after that peer messages first.
3. `createSocketSender` (`send.ts:54-59`) is fire-and-forget: `net.connect`, `client.on('error', () => undefined)`, `client.end(...)`. ENOENT and ECONNREFUSED are swallowed.
4. `cli-hierarchy send` (`pipeline-cli/src/cli/hierarchy.ts:1834-1875`) then prints `{"ok":true,"sent":"uds:/tmp/cc-socks/7550.sock"}` and exits 0. The message is lost.

Separately, `--to <roster name>` never uses a socket: it types into the target's tmux pane (`createTmuxBriefSender`, `brief-notify.ts:47-72`). Only the caller's own board roster is read, so a peer in another project (for example `arcana-website-planner`) can be reached only by replying to an address it sent, which is the path that goes stale.

**Failure.** 2026-11-22: the arcana-website hierarchy was relaunched at 00:38Z (planner pid 7550 -> 60563). The ai-sdlc planner's message to `uds:/tmp/cc-socks/7550.sock` was lost. The live socket `/tmp/cc-socks/60563.sock` existed the whole time, and `~/.claude/sessions/*.json` (read by `readSessionRegistry`, `pipeline-cli/src/hierarchy/registry.ts:13`) already mapped the name to the new pid. The operator: "there is an issue in being able to address the correct socket and repair [to] the correct socket."

**Relation to AISDLC-1391.** 1391 derives the socket from the roster pid for planner notices only, and its "throws if the send fails" criterion needs a sender that reports failure. This task makes the shared sender report failure and moves `cli-hierarchy send` (names and replies, own project and peers) onto the same name-to-current-socket lookup. Work after 1391 lands so both use one socket-directory constant and one sender.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a sender means a session, not a pid; the address is an implementation detail that changes on every relaunch, so nothing should hold it longer than one send. 2. Deleted: trusting a stored `uds:` path as the target, and the exit-0-on-lost-message path. 3. Simplified: one resolver, session name -> live pid (session registry on this machine, which spans projects) -> `/tmp/cc-socks/<pid>.sock`, used for every `send`. 4. Accelerated: none. 5. Automated: tests below.

- **One resolver.** `resolveSessionSocket(name)` looks the name up in the session registry (`readSessionRegistry`; extend `RegistrySession` with the harness's own `messagingSocketPath` and `procStart` fields, e.g. `~/.claude/sessions/60563.json` carries `"messagingSocketPath":"/tmp/cc-socks/60563.sock"`). It picks the entry whose process is alive with a matching `procStart` (so a reused pid is not mistaken for the session) and returns its `messagingSocketPath` if the file exists. Use the harness-reported path rather than building one from the pid; if 1391 shipped a socket-directory constant, keep it only as a fallback for entries without the field. The registry is machine-wide, so a peer in another project resolves without reading its roster.
- **Replies repair themselves.** The received log stores `{address, name}` (the `from-name` the hook already reads via `senderOf`, `executor.ts:250-254`). `--to <uds address>` resolves the stored name to its current socket; if the stored address is dead and the name resolves to a new socket, send to the new one and print both in the result (`"repaired": "uds:...7550.sock -> uds:...60563.sock"`). Entries whose name no longer resolves are dropped when the log is next written.
- **Names use the socket.** `--to <name>` goes to the resolved socket. The peer guard is unchanged: a name must be in the caller's roster or in the received log (a peer that has messaged us); this task does not widen who may be addressed.
- **The sender reports failure.** `createSocketSender` awaits the connect and the write, and rejects on error. `cli-hierarchy send` exits 1 with `{"ok":false,"to":...,"reason":...}` when no live socket resolves or the write fails. It never falls back to typing into a pane.
- **Out of scope:** briefs and wake commands to dispatch and executor panes (as in 1391); authentication of senders (the guard stays a mistake guard).

## Acceptance Criteria

- [ ] #1 A test: `send --to <uds address>` whose socket is gone, with the stored name now at a new pid, delivers to the new socket and reports the repair.
- [ ] #2 A test: `send --to <uds address>` whose name no longer resolves exits 1 with a reason, and nothing is typed into any pane.
- [ ] #3 A test: `send --to <name>` for a peer in another project (name present in the received log, absent from the caller's roster) resolves through the session registry and delivers to its socket.
- [ ] #4 A test: a reused pid whose start time differs from the registry entry's `procStart` is not treated as the session, and the socket comes from the entry's `messagingSocketPath`.
- [ ] #5 A test: the socket sender rejects on ENOENT and ECONNREFUSED, and `cli-hierarchy send` exits non-zero instead of printing `ok: true`.
- [ ] #6 A test: the received log stores the sender name with each address and drops entries whose name no longer resolves.
- [ ] #7 Manual check in the PR: relaunch a peer session, then `send --to` its old address; the message arrives at the new session.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
