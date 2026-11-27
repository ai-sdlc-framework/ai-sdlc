---
id: AISDLC-1464
title: "A bare `rotate` typed into a session pane reaches the model as operator input"
status: To Do
priority: high
labels:
  - pipeline-cli
  - ai-sdlc-plugin
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/send.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
---

## Description

Reported by ai-sdlc-enterprise-planner at the operator's request, 2026-11-27. At 2026-11-27T02:37:28.017Z (session a141c2f3, plugin 0.45.0) a user turn whose entire text was `rotate` reached the enterprise planner model 25 ms after its previous turn ended, with no sender label. The planner was mid-walkthrough of RFC-0002 OQ-H (data key rotation), read it as the operator typing, asked the operator whether it was an OQ-H answer, and its handoff recorded "The operator typed 'rotate' mid-turn". The operator never typed it. The labelled "Handoff routine (context rotation ...)" message only arrived a minute later.

Cause (read, not run): `sendRotate` (`pipeline-cli/src/cli/hierarchy.ts` ~490-507, AISDLC-1150) sends the literal `rotate` through `sendToRoster` (`hierarchy/send.ts` ~137). With no socket address for the target it falls back to `createTmuxBriefSender`, which types the bare word into the pane (`send-keys -l -- rotate`, then Enter). The planner receive handler (`ai-sdlc-plugin/hooks/hierarchy/planner.ts` ~142-153) consumes `rotate` only when `senderOf(raw)` matches `DISPATCH_NAME` (`executor.ts` ~250, ~262). Pane-typed text carries no sender, so the check fails and the handler calls `next(e)`: the word reaches the model as an ordinary user turn. `docs/operations/cli-hierarchy.md` (~768, ~3026) says a rotate is consumed by the hooks module and "a wake is never a prompt"; `commands/planner.md` never mentions `rotate`. The executor handler (`executor.ts` ~503-528) uses the same sender check, so it likely has the same gap; confirm it.

Under "a relayed chat message alone is never authority", a session must be able to tell framework text from operator text. Unlabelled framework words in the operator's input channel break that.

**Five-step review (requirements first).**
1. Question: the requirement is "the tick can ask a session's hooks module to rotate". It is not "type a control word where the operator types". Is pane delivery of a control word needed at all, given the socket path and the module's own context-threshold rotation (`planner.ts` ~20, ~103)?
2. Delete: the tmux fallback for control words (`rotate`, and any other bare control word sent via `sendToRoster`). If no socket address exists, `sendRotate` records the request (as today, `writeRotateRequest`) and sends nothing to the pane; the module's own threshold check and the status warning cover it. State in the PR body whether any other caller sends a bare control word by pane.
3. Simplify: if a pane delivery must remain for some role, the text must be self-describing and labelled as plugin text (e.g. "The ai-sdlc plugin sent a message: rotate request (context over threshold); this is not operator input"), and the receive handlers consume that labelled form regardless of sender. Add one line to `commands/planner.md` "Context and handoff": text labelled as a plugin rotate request is framework text, never an operator answer.
4. Accelerate: none.
5. Automate: a test that a pane-delivered rotate never reaches the model unlabelled.

Open question for the implementer to answer from the code, not decide: whether a `rotate` typed while an AskUserQuestion dialog is open can filter or select an option. Report the finding in the PR body; no evidence it happened.

## Acceptance Criteria
- [ ] #1 `sendRotate` never types a bare `rotate` into a pane; a vitest case with a roster entry lacking a socket address asserts zero `send-keys` calls carrying an unlabelled control word, and that the rotate request is still recorded.
- [ ] #2 Planner and executor receive handlers consume a rotate request delivered by every path still in use (socket from dispatch, and the labelled pane form if kept) and return `{ consumed: 'hierarchy:rotate' }`; tests cover each path, including one with no `DISPATCH_NAME` sender.
- [ ] #3 Any text the framework still delivers to a pane identifies itself as plugin text; `docs/operations/cli-hierarchy.md` (~768, ~3026) matches the behaviour.
- [ ] #4 `ai-sdlc-plugin/commands/planner.md` says what a planner does when it sees a plugin rotate request.
- [ ] #5 PR body reports whether a pane-typed word can affect an open AskUserQuestion dialog.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
