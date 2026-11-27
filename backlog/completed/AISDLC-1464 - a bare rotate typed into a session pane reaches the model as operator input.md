---
id: AISDLC-1464
title: "Rotation and cross-session delivery stop typing into panes and stop reporting false success (DEC-0455 a)"
status: Done
priority: high
labels:
  - pipeline-cli
  - ai-sdlc-plugin
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/send-resolve.ts
  - pipeline-cli/src/hierarchy/brief-notify.ts
  - pipeline-cli/src/hierarchy/status.ts
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/send.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
---

## Description

**Widened 2026-11-27 by DEC-0455 option a** (operator, decision rubric; applies DEC-0415 finish-migration to rotation and delivery). Original report kept below; the Scope section is now authoritative.

### Scope (DEC-0455 a)

1. **No false success.** `cli-hierarchy send` stops writing a raw line to the harness socket (`send.ts` ~105-112): the harness drops it while the CLI prints `ok` (confirmed 2026-11-27: two sends to the enterprise planner never arrived; `SendMessage` to the same session did). The harness publishes no socket wire format, so the CLI must not imitate one. A send with no real delivery path exits non-zero and names the working paths (`SendMessage` from a model session, `$.session.send` from a hooks module). It never falls back to the pane.
2. **No bare control word by pane.** `sendRotate` never types `rotate` (or any control word) into a pane; it records the request (`writeRotateRequest`) and the target's own module rotates on its threshold. List in the PR body every remaining `send-keys` site (`brief-notify.ts`, `tmux.ts` ~163/174/264, `escalation-chain.ts` ~134) and which of them this PR removes; sites kept are covered by AISDLC-1465 or a dated RFC-0058 interim exception (DEC-0415).
3. **Rotation log.** The module `rotate()` path (`executor.ts` ~379-411, planner equivalent) appends one line per attempt (role, session, tokens, handoff result, clear result, fallback used) to a file under `.ai-sdlc/dispatch/log/`. Today nothing records whether a module clear happened; this log is the evidence AISDLC-1465 needs.
4. **Delivery receipt and health.** A message sent through `$.session.send` gets a receipt from the receiving module (consumed or forwarded to the model); `cli-hierarchy status` shows per session the last send, its receipt state and the last rotation from the log. A socket that exists but returns no receipt shows as unhealthy; health is never "file exists" (`send-resolve.ts` ~61-82 today).

### Original report

Reported by ai-sdlc-enterprise-planner at the operator's request, 2026-11-27. At 2026-11-27T02:37:28.017Z (session a141c2f3, plugin 0.45.0) a user turn whose entire text was `rotate` reached the enterprise planner model 25 ms after its previous turn ended, with no sender label. The planner was mid-walkthrough of RFC-0002 OQ-H (data key rotation), read it as the operator typing, asked the operator whether it was an OQ-H answer, and its handoff recorded "The operator typed 'rotate' mid-turn". The operator never typed it. The labelled "Handoff routine (context rotation ...)" message only arrived a minute later.

Cause (read, not run): `sendRotate` (`pipeline-cli/src/cli/hierarchy.ts` ~490-507, AISDLC-1150) sends the literal `rotate` through `sendToRoster` (`hierarchy/send.ts` ~137). With no socket address for the target it falls back to `createTmuxBriefSender`, which types the bare word into the pane (`send-keys -l -- rotate`, then Enter). The planner receive handler (`ai-sdlc-plugin/hooks/hierarchy/planner.ts` ~142-153) consumes `rotate` only when `senderOf(raw)` matches `DISPATCH_NAME` (`executor.ts` ~250, ~262). Pane-typed text carries no sender, so the check fails and the handler calls `next(e)`: the word reaches the model as an ordinary user turn. `docs/operations/cli-hierarchy.md` (~768, ~3026) says a rotate is consumed by the hooks module and "a wake is never a prompt"; `commands/planner.md` never mentions `rotate`. The executor handler (`executor.ts` ~503-528) uses the same sender check, so it likely has the same gap; confirm it.

Under "a relayed chat message alone is never authority", a session must be able to tell framework text from operator text. Unlabelled framework words in the operator's input channel break that.

**Five-step review (requirements first).** (original; the Scope above supersedes step 3's labelled-pane-text alternative: no pane delivery is kept for control words)
1. Question: the requirement is "the tick can ask a session's hooks module to rotate". It is not "type a control word where the operator types". Is pane delivery of a control word needed at all, given the socket path and the module's own context-threshold rotation (`planner.ts` ~20, ~103)?
2. Delete: the tmux fallback for control words (`rotate`, and any other bare control word sent via `sendToRoster`). If no socket address exists, `sendRotate` records the request (as today, `writeRotateRequest`) and sends nothing to the pane; the module's own threshold check and the status warning cover it. State in the PR body whether any other caller sends a bare control word by pane.
3. Simplify: if a pane delivery must remain for some role, the text must be self-describing and labelled as plugin text (e.g. "The ai-sdlc plugin sent a message: rotate request (context over threshold); this is not operator input"), and the receive handlers consume that labelled form regardless of sender. Add one line to `commands/planner.md` "Context and handoff": text labelled as a plugin rotate request is framework text, never an operator answer.
4. Accelerate: none.
5. Automate: a test that a pane-delivered rotate never reaches the model unlabelled.

Open question for the implementer to answer from the code, not decide: whether a `rotate` typed while an AskUserQuestion dialog is open can filter or select an option. Report the finding in the PR body; no evidence it happened.

## Acceptance Criteria
- [x] #1 `cli-hierarchy send` never writes a raw line to a harness socket; with no real delivery path it exits non-zero naming SendMessage and `$.session.send`; no pane fallback. Vitest covers both.
- [x] #2 `sendRotate` never types a bare control word into a pane; a vitest case with a roster entry lacking a socket address asserts zero `send-keys` calls and that the rotate request is still recorded.
- [x] #3 Planner and executor receive handlers consume a rotate request from dispatch via `$.session.send` and return `{ consumed: 'hierarchy:rotate' }`; a rotate with no `DISPATCH_NAME` sender never reaches the model as operator input. Tests cover both.
- [x] #4 Every module rotation attempt appends one line to the rotation log (role, session, tokens, handoff ok, clear ok, fallback); tested.
- [x] #5 `cli-hierarchy status` shows per session the last delivery receipt and the last logged rotation; a session whose socket exists but returns no receipt is shown unhealthy. Tested.
- [x] #6 `docs/operations/cli-hierarchy.md` and `ai-sdlc-plugin/commands/planner.md` describe the delivery channels and what a session does with a rotate request; PR body lists every remaining `send-keys` site and its owner (AISDLC-1465 or an RFC-0058 dated exception), and reports whether a pane-typed word can affect an open AskUserQuestion dialog.
- [x] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

Rebased the existing AISDLC-1464 work onto main, which now includes the AISDLC-1448 change that clears a session only after its handoff is proven. The work: `cli-hierarchy send` exits 1 and names SendMessage and $.session.send, with no socket write and no pane fallback; a rotate request is only recorded and dispatch delivers it through $.session.send; a bare `rotate` with no sender never reaches the model; every module rotation attempt, proven or unproven, appends to log/rotations.jsonl; receiving modules write receipts and status reports delivery health from them. Also fixed the minor review findings and added RFC-0058 interim exceptions, dated 2026-11-27, for the pane paths that remain.

## Changes

- ai-sdlc-plugin/commands/planner.md
- ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
- ai-sdlc-plugin/hooks/hierarchy/executor.ts
- ai-sdlc-plugin/hooks/hierarchy/planner.ts
- ai-sdlc-plugin/hooks/hierarchy/register.tsx
- ai-sdlc-plugin/mods/tests/hierarchy-dispatch.test.ts
- ai-sdlc-plugin/mods/tests/hierarchy.test.ts
- docs/operations/cli-hierarchy.md
- pipeline-cli/src/cli/hierarchy.test.ts
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/hierarchy/delivery.test.ts
- pipeline-cli/src/hierarchy/delivery.ts
- pipeline-cli/src/hierarchy/hierarchy.test.ts
- pipeline-cli/src/hierarchy/index.ts
- pipeline-cli/src/hierarchy/send-resolve.ts
- pipeline-cli/src/hierarchy/status.ts
- spec/rfcs/RFC-0058-session-hierarchy-on-mods.md

## Design decisions

This was a second round. PR #3161 already existed and showed DIRTY against main, so I rebased onto e6f8f3b60. The conflicts were with the AISDLC-1448 handoff-proof rotation, in executor.ts rotate(), planner.ts imports, sendRotate/requestRotate in cli/hierarchy.ts, the cli-hierarchy.md over-context section and one hierarchy.test.ts block. I resolved them by keeping main's proof flow throughout. rotate() no longer writes the handoff itself, so its log line records handoffOk:true; alertUnproven now also logs a line with handoffOk:false and clearOk:false; requestRotate keeps the roster guard and calls main's markRotation. The plugin rotation-log tests were rewritten to run through the cliFake proof flow. Please re-check those resolutions, because the earlier review approvals were for the old commit 49da961bc.

Review findings fixed: a receipt counts as received only when its sender matches the send; receipts are written only for dispatch-sent messages and never by dispatch itself; status replaces control characters in board text before printing; a comment explains why rotateSent is kept in memory; and there are new tests for the dispatch self-skip, unsafe names, and clear followed by tick.

AC6 needs each kept send-keys site to have an owner. AISDLC-1465 covers only rotation, so I added a dated 2026-11-27 interim-exception subsection to the Signed Off RFC-0058 (under 'Upstream gaps') for brief-notify, escalation-chain, tmux sendExit and the exit-dialog answer; tmux sendLine stays with AISDLC-1465. The operator should confirm that RFC edit.

One gap is open: planner-notify.ts (createSocketSender) still writes a raw line to the planner's socket and can report success when nothing arrived. It is outside AC1. The docs now say so, and no task was filed (AISDLC-308). The PR body records the AskUserQuestion finding: the old pane sender typed text and then Enter without checking pane state, so it could have submitted a highlighted option; there is no evidence it did.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

- AISDLC-1465
- declined: planner-notify raw socket writer needs a new task, which the operator must authorize per AISDLC-308
