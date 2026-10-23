---
id: AISDLC-1051
title: 'RFC-0058 phase 0: the hierarchy spike returns the host consumed shape, strips the escaped agent-message wrapper, and the live protocol finally measures a silent consume'
status: In Progress
assignee: []
created_date: '2026-10-22'
labels:
  - hierarchy
  - plugin
  - spike
dependencies: []
references:
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - ai-sdlc-plugin/hooks/hierarchy-spike/hooks/register.ts
  - ai-sdlc-plugin/hooks/hierarchy-spike/README.md
  - ai-sdlc-plugin/mods/tests/hierarchy-spike.test.ts
priority: high
dispatchable: true
---

## Description

The live protocol was run against main once the envelope fix (PR #1944) had landed (table in PR #1944's body, section "Live protocol run on main 0a4b417b3"). Half of phase 0 is now answered: `hier:run clear` really ran `/clear` from the mod (session.end reason clear, new session id, context 50,002 to 46,877), the `$.store` keys survived the clear, `hier:run compact` compacted (9.8 s), and `hier:dump` submitted the log through `$.prompt.submit`. The other half still fails: all five `hier:consume` messages cost a model turn (median 2.02 s, 134 output tokens, versus 1.51 s and 57 tokens for the plain baseline), so the measured saving is zero. Two root causes, both with evidence in the debug log:

1. **Wrong return shape.** For every matched command the host logged `hook failed: hierarchy-spike (session.receive; skipped; what is below it ran in its place)` and `session.receive hook skipped: returned the wrong shape (a consumed that is not a string)`. The host contract in the generated `.claude-plugin/types/claude-code/index.d.ts` is `SessionReceiveResult = { text } | { consumed: string }`; `register.ts` returns `{ consumed: true }`, and the unit test at `ai-sdlc-plugin/mods/tests/hierarchy-spike.test.ts` asserts that same wrong shape. Side effects ran before the return, which is why clear and compact happened while the message still reached the model.
2. **Escaped inner wrapper on subagent-originated sends.** A message sent from a subagent arrives with a backslash-escaped `agent-message` wrapper around the text (`<\agent-message from="...">` and `<\/agent-message>`), which `innerText()` does not strip, so the match misses. Sends from a headless main session (`claude -p`) carry no inner wrapper and matched. The vitest fixture uses an unescaped wrapper, which is not the live shape.

A third observation for phase 1, not for this task: after the mod-run clear, no post-clear `session.start` hook fired, so the `/hierarchy-spike:hier-ping` follow-up submission is unverified. Record it in the README protocol notes as an open point for phase 1.

Fix: return `{ consumed: 'hier:<command>' }` (a string naming the consumed command) from every handled branch; extend `innerText()` to strip the optionally backslash-escaped `agent-message` open and close tags; change the vitest fixture to the live escaped shape and assert the string `consumed` value; then rerun the protocol from the README with a headless `claude -p` sender and with a subagent sender, and replace the table in this task's PR body with the measured numbers. The spike stays a standalone mod folder that phase 1 removes.

**Five-step review (requirements first).** Requirement questioned: is a third spike round worth it when clear, compact and store survival are already proven? Yes: consume silence is the one fact that decides whether phase 1 can drop the model relay at all, and it is one return value away. Deletion: nothing to delete; `{ consumed: true }` becomes the string the host requires. Simplified: the host's own type file is the contract, so the test asserts against it instead of a guessed shape. Accelerated: the executor runs the protocol itself with a headless sender in its worktree (the method is in #1944's body), no second interactive session. Automated last: the unit test on the live escaped wrapper and the string return guards both bugs.

## Acceptance Criteria

- [ ] `register.ts` returns `{ consumed: <string> }` for every handled `hier:` command and the debug log shows no `returned the wrong shape` line during the protocol run.
- [ ] `innerText()` strips the backslash-escaped `agent-message` wrapper; the unit test feeds the live escaped shape and the plain headless shape and asserts the string `consumed` value for each command.
- [ ] The PR body carries the rerun table: `hier:consume` rows show 0 model turns from both a headless and a subagent sender; clear, compact and dump rows restate the outcomes; baseline rows give the model-relayed cost; the README notes the unverified post-clear `session.start` for phase 1.
- [ ] RFC-0058's phase 0 paragraph records the measured saving in one sentence from the table; no Open Question is touched.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
