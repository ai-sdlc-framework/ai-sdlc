---
id: AISDLC-873
title: 'feat(decisions): render standing decision rules into dispatch and executor prompts'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [decisions, hierarchy, prompts]
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/decisions/projection.ts
  - pipeline-cli/src/decisions/decision-record.ts
  - docs/operations/prompt-rules.md
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Context

Source: 24h PR-drain review 2026-10-14 (planner + operator). Operator constraint: stability before unsupervised spend — fixes must be deterministic code or settings, spend zero tokens on their own, and never relaunch or drive sessions.

Of 25 escalations in 24h, 6 repeated a shape already ruled by a standing decision on main (DEC-0187 retry-cap re-enqueue, DEC-0202 local-test waiver, the next-step resume class) and about 7 more a same-class shape. Each parks an executor until a tick relays it, and a self-cleared session rediscovers the rules. The catalog reader is under `pipeline-cli/src/decisions/`; there is no module named `catalog`, so `projection.ts` and `decision-record.ts` are cited as the nearest real ones.

## Fix

**Five-step review (requirements first).** Requirement questioned: "sessions should look up prior decisions". A lookup is a model step each session repeats, for a rule that is already settled. Delete: the rediscovery and the relay for already-ruled shapes. Simplify: mark a decision as standing and render it as one line through the existing single rule source (AISDLC-651.2). Accelerate: the rule is in context at SessionStart, so no wait for a tick. Automate: deterministic rendering from the catalog, no model.

1. Add a `standing: true` marker (or the rule "scope `dispatch-board` and answered") to the decision record schema and projection.
2. Extend `ai-sdlc-plugin/hooks/lib/prompt-rules.js` to read answered standing decisions from the catalog and emit one line per rule (id, trigger shape, the action) into the operator-dispatch and executor command renderings at SessionStart.
3. Update `docs/operations/prompt-rules.md` and `docs/operations/decision-authority.md`: how to mark a decision standing, that a standing rule authorizes only the action it names, and that a record not yet on main is not rendered.
4. Mark DEC-0187, DEC-0202 and the next-step resume class standing as the first users, through the normal record path.

## Acceptance Criteria

- [ ] #1 An answered decision with `standing: true` on main renders exactly one line into the operator-dispatch and executor prompts; an unanswered, non-standing or not-on-main one renders nothing.
- [ ] #2 Rendering is deterministic (same catalog gives byte-identical output) and calls no model; covered by a unit test.
- [ ] #3 Rules are defined in `prompt-rules.js` only; `operator-dispatch.md` and `executor.md` are not hand-edited per rule.
- [ ] #4 The plugin model-pin gate (`pnpm test:plugin-model-pins-gate`) and the prompt-rules tests still pass.
- [ ] #5 Docs describe the marker, the authority limit and the first three standing rules.

## Out of scope

- Resolving or editing any RFC Open Question.
- Making any weakening decision standing; only already-answered class (a) rules.
- Changing escalation classes or the Decision Catalog event format.
