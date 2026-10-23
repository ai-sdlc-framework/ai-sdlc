---
id: AISDLC-1058
title: 'hierarchy hooks module registers session.receive once per module, so the plugin validator accepts it and the roster sessions load it'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - plugin
  - hierarchy
  - bug
  - velocity
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hooks.json
  - ai-sdlc-plugin/mods/tests/hierarchy.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

The RFC-0058 hierarchy hooks module (`ai-sdlc-plugin/hooks/hierarchy/register.tsx`, listed under `modules` in `ai-sdlc-plugin/hooks/hooks.json`) is refused by Claude Code's module validator, so no roster session loads it. Found 2026-10-23 during the operator's mod smoke test after a full `cli-hierarchy down && up` on Claude Code 2.1.309 (floor 2.1.307): `cli-hierarchy clear --self` wrote `rotate-request-ai-sdlc-planner.json` and nothing consumed it; the dispatch session answered a roster `send` with a model turn and said the prompt reached it "outside the model-less host". `claude plugin validate ai-sdlc-plugin` (and the same on the installed cache copy 0.31.0) fails with:

```
modules../hierarchy/register.tsx: hooks/hierarchy/planner.ts, compiled line 39 `on("session.receive", async ($, e, next) => {`:
on("session.receive") is registered twice without a matcher; the first is at hooks/hierarchy/dispatch.ts:251
```

The validator is static: it sees every `on(...)` call in the compiled module regardless of the runtime role gate in `register.tsx`, so the dispatch role (phase 2) and the planner role (phase 3, the commit that broke it) each registering their own `session.receive` handler is a duplicate even though only one role ever arms per session. `executor.ts` registers `session.receive` as well. With the module refused there are no dispatch ticks, no executor wake, no rotation at the context thresholds, and no rotate-request consumption; the keystroke fallback was deleted in phase 4, so the hierarchy is inert.

Fix: register each session event once per module. The register entry point registers one `session.receive` (and likewise any other event more than one role uses) and forwards the event to the handler of the role that armed, or the roles register through one shared helper that installs the handler once and chains role callbacks. Keep the role code where it is; only the registration point moves. Re-run `claude plugin validate ai-sdlc-plugin` until it passes, then re-run the operator smoke test in `docs/operations/cli-hierarchy.md` (send ping, `clear --self`, `clear <executor>`, `attach`) against a restarted hierarchy and record the result in the PR body.

**Five-step review (requirements first).** Requirement questioned: does each role need its own `session.receive` registration? No; a session has exactly one role, so one handler per event per module is the contract the validator enforces. Deletion: the per-role `on('session.receive', ...)` calls in planner.ts and dispatch.ts (and executor.ts if it is the third), replaced by one registration. Simplified: one place decides which role receives a message. Accelerated: nothing to speed up. Automated last: a Vitest test in `ai-sdlc-plugin/mods/tests/` that registers the module against a fake `on` recording every `(event, matcher)` pair across all roles armed in turn, and fails when any event is registered twice without a matcher; this stands in for the validator, which CI cannot run (no Claude CLI on the runner). The phase 1 task's acceptance line "claude plugin validate passes" was true at phase 1 and nothing re-checked it at phases 2 to 4.

## Acceptance Criteria

- [ ] `claude plugin validate ai-sdlc-plugin` reports no error for `hooks/hooks.json` modules (warnings about icon, marketplace version and `runtimeDependencies` are out of scope).
- [ ] A Vitest test fails on any event registered twice without a matcher across the executor, dispatch and planner roles, and passes on the fixed module.
- [ ] Existing tests in `ai-sdlc-plugin/mods/tests/` still pass: executor wake, rotate consume, dispatch tick with zero prompt submissions, planner last-reply store.
- [ ] After `cli-hierarchy down && up` with the fixed plugin: `cli-hierarchy clear --self` from the planner consumes the rotate request within one tick and the planner restarts with `Last reply before the clear:`; the dispatch pane shows the board pane and no model turn answers a `send`. Result recorded in the PR body.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
