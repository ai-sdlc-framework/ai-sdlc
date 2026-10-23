---
id: AISDLC-1050
title: 'RFC-0058 phase 0: the hierarchy spike matches the inner message text, not the envelope, and the live protocol is rerun with measured numbers'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - hierarchy
  - plugin
  - spike
dependencies: []
references:
  - spec/rfcs/RFC-0058-session-hierarchy-as-mods.md
  - ai-sdlc-plugin/hooks/hierarchy-spike/hooks/register.ts
  - ai-sdlc-plugin/hooks/hierarchy-spike/README.md
priority: high
dispatchable: true
---

## Description

The phase 0 spike landed with PR #1913 (AISDLC-1033), but the live protocol run against its final head (table in that PR's body, section "Live protocol rerun on head 15adad8d3") shows the phase 0 exit criterion is not met. `session.receive` fired for every peer message (hook latency 22 to 114 ms, store log confirms `origin.kind: peer`), but the `e.text` the hook receives is the whole cross-session envelope:

```
<cross-session-message from="..." ...><agent-message ...>hier:consume</agent-message></cross-session-message>
```

so `text.startsWith('hier:consume')`, `text.startsWith('hier:dump')` and the `^hier:run (clear|compact)` regex in `register.ts` never match. Every message, including the five `hier:consume` sends, reached the model and cost a full turn (median 2.4 s, 150 output tokens, versus 1.7 s and 45 tokens for the plain baseline). The clear and compact never ran, so the two facts phase 0 exists to settle, consume silence and an in-mod clear with a surviving store, are still unanswered, and AISDLC-1034 (phase 1) stays blocked on the board until they are.

Three further findings from the run belong in the protocol: the receiver drops a third byte-identical peer message from the same sender, so protocol texts must be distinguishable (`hier:consume 1` to `hier:consume 5`); the mod's command is namespaced `/hierarchy-spike:hier-ping`, so `$.prompt.submit` must use that name; and `$.store` persists under `~/.claude/plugins/store/`, which is how the log was recovered when `hier:dump` never reached the hook.

Fix: at the top of the `session.receive` handler extract the inner text once (strip the envelope tags, trim) and match every `hier:` command on it, keeping the raw text in the log line; make `/hier-ping` submission use the namespaced name; then rerun the protocol from the README (five consumes with distinct texts, five baseline messages, `hier:run clear`, `hier:run compact`, `hier:dump`) and record the measured table in this task's PR body and as the phase 0 saving in RFC-0058's Implementation Plan paragraph. No production code changes; the spike stays a standalone mod folder that phase 1 removes.

**Five-step review (requirements first).** Requirement questioned: is a second spike round needed, or can phase 1 start on the design alone? It is needed: the RFC makes the consume-silence and clear facts the gate for phase 1, and both are unmeasured. Deletion: the `startsWith` matchers on the raw envelope go; one extraction, one match site. Simplified: the protocol gains the three facts above so the next run needs no diagnosis. Accelerated: the executor runs the protocol itself in its worktree and pastes the table, no second session hand-off. Automated last: a unit test on the envelope extraction guards the one bug that voided the first run.

## Acceptance Criteria

- [ ] `register.ts` matches `hier:consume`, `hier:dump` and `hier:run clear|compact` on the inner text of the cross-session envelope; a unit test feeds the real envelope shape and asserts `{ consumed: true }` for each.
- [ ] `/hier-ping` is submitted by its namespaced name and starts a turn once idle.
- [ ] The PR body carries the rerun table: `hier:consume` rows show 0 model turns; the `hier:run clear` row states whether the session cleared, the mod reloaded and `$.store` survived; the `hier:run compact` row states whether it compacted; baseline rows give the model-relayed cost for comparison.
- [ ] RFC-0058's phase 0 paragraph records the measured saving (one sentence, numbers from the table); no Open Question is touched.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
