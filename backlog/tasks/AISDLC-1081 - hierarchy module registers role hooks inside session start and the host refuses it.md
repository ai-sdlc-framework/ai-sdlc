---
id: AISDLC-1081
title: 'hierarchy hooks module registers its role hooks from inside session.start, which the host refuses, so no session ever ticks, rotates or writes its health file'
status: In Progress
assignee: []
created_date: '2026-10-26'
labels:
  - plugin
  - hierarchy
  - bug
  - rca-2026-10-26
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/mods/tests/hierarchy.test.ts
  - ai-sdlc-plugin/mods/tests/hierarchy-register-once.test.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Every roster session shows `MODULE absent` in `cli-hierarchy status`, no `handoff/module-<name>.json` heartbeat is ever written, dispatch never ticks and rotate requests are never consumed, even though the module loads. A headless probe on 2026-10-26 (Claude Code 2.1.310, `claude -p --debug` with `AI_SDLC_HIERARCHY_ROLE=executor`) shows the engine loading the module (`hooks module ai-sdlc@ai-sdlc-local loaded ... events: session.start`), the gate reaching the identity log line, and then:

```
[ERROR] hook failed: ai-sdlc: errorKind=HooksError (session.start; skipped; what is below it ran in its place)
[ERROR] ai-sdlc: session.start hook skipped: threw ai-sdlc: on("session.receive") after register() returned: on() is for register(); a hook may not register hooks
```

`register.tsx` registers only `session.start` from `register()` and wires the role hooks (`session.receive`, `turn.start`, `turn.complete`, `session.measure`, `clock.every` tick) from inside that gate through `wire(...)`, after the role is known. The host refuses any `on()` call after `register()` returned, so the gate throws before `health({ state: 'loaded' })` and before the dispatch timer is registered. `safe()` swallows nothing here because the throw is in `on()` itself, and the runbook's "the validator prints the refusal in the pane" does not hold: the line only reaches the debug log. The plugin store log (`hierarchy/log`) ends at the identity line for every session since the module shipped, which is the same signature.

## Fix

**Five-step review (requirements first).** The requirement questioned is "register role hooks lazily so a session without a hierarchy role gets none": the host already supports that through a matcher or an early `return next(e)` inside each hook, so late registration is not needed. Deleted: the `wire(...)` late-registration path and the router's "current role" switch that only existed to make late wiring safe. Simplified: `register()` registers every hook up front; each hook reads the role once (cached in module state after `session.start`) and returns `next(e)` at once when the session has no role or a different one. Accelerated: nothing; the hooks are no-ops for roleless sessions. Automated: a test that runs the module under a host stub which throws on `on()` after `register()` returns (the real host's rule), so the regression cannot ship again.

1. Move every `on(...)` call into `register()`. Role hooks keep their bodies; each starts with a role guard that uses the role resolved by the `session.start` gate.
2. Register the dispatch tick (`$.clock.every`) from `register()` or from inside the `session.start` hook body only through `$` calls, never through `on()`.
3. Keep the `session.start` gate as the place that resolves the role, probes the primitives and writes the health heartbeat; it must write `loaded` or `refused` on every path that reaches a role.
4. The host-stub tests gain the real host rule: `on()` throws once `register()` has returned. The existing tests must pass under that stub.
5. Update the "Module absent" troubleshooting entry in `docs/operations/cli-hierarchy.md`: the refusal reaches the pane only for validator refusals; a hook that throws is visible only in `claude --debug` logs and in the plugin store `hierarchy/log`, so the runbook names both places and the one-line probe (`claude -p ... --debug` with the role env, then grep the newest `~/.claude/debug/*.txt` for `ai-sdlc:`).

## Acceptance Criteria

- [ ] `register()` is the only place that calls `on()`; a grep for `on(` outside `register()` in `ai-sdlc-plugin/hooks/hierarchy/` returns nothing.
- [ ] A test host stub that throws on `on()` after `register()` returns is used by the hierarchy tests, and all of them pass.
- [ ] A headless probe (`claude -p "ok" --max-turns 1 --debug` with `AI_SDLC_HIERARCHY_ROLE=executor` and `AI_SDLC_HIERARCHY_SESSION=probe`) writes `.ai-sdlc/dispatch/handoff/module-probe.json` with `state: loaded`, and the debug log shows no `session.start hook skipped` line for `ai-sdlc`.
- [ ] After `cli-hierarchy down && up`, `cli-hierarchy status` shows `MODULE loaded` for the dispatch host and the executors, and a rotate request is consumed within the 30 s window.
- [ ] The "Module absent" runbook entry names the debug log and the store log as the places a thrown hook is visible, with the probe command.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
