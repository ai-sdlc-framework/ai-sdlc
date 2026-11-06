---
id: AISDLC-1205
title: 'Hierarchy hooks module registers without a process global'
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy hooks defect
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
priority: high
dispatchable: true
---

## Description

**Source.** Operator bug report relayed through the ai-sdlc-io session on 2026-11-06; verified by the planner against main.

Since AISDLC-1181 landed (commit 6c5990af, #2359, 2026-11-04 21:49Z) every new session's hierarchy hooks module throws at `session.start`:

```
[ERROR] ai-sdlc: session.start hook skipped: threw ReferenceError: process is not defined
```

`resolveBoardDir` in `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts` (line 103) reads `process.env.CLAUDE_PROJECT_DIR` with the bare `process` global. A hooks module runs in the host sandbox with no `process` or `fs` global (`executor.ts` line 187 documents this; every other env read in `register.tsx` goes through `$.env.get`). `register()` awaits `writeModuleHealth`, which calls `resolveBoardDir`, right after the identity log line, so registration dies before the heartbeat write and before `$.clock.every`. The session then runs with no module: no ticks, no heartbeat, no rotation, no verdict handoff.

**Evidence.** No `.ai-sdlc/dispatch/handoff/module-ai-sdlc-executor-*.json` written since `ai-sdlc-executor-aisdlc-1182` at 2026-11-04 14:40 local; every executor since has run without the module. The long-running operator-dispatch session still heartbeats only because it loaded pre-1181 code. In ai-sdlc-io, `cli-hierarchy up` exits 1 with `MODULE stale: no heartbeat` after a down/up.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* The requirement is the AISDLC-1181 one: an absolute board dir. Reading `CLAUDE_PROJECT_DIR` is still right; only the access path is wrong.
2. *Delete.* Nothing to delete; `resolveBoardDir` is the single resolver every handoff writer uses.
3. *Simplify.* Thread the value through the ports the module already has: read `CLAUDE_PROJECT_DIR` with `$.env.get` in `register.tsx` and pass it into `resolveBoardDir` (or into the `DispatchPorts`), so `dispatch.ts` never touches a global. A `typeof process !== 'undefined'` guard is the fallback if threading is impractical, but it leaves the hazard in place.
4. *Accelerate.* None.
5. *Automate.* A test loads the module under a scope with no `process` global and asserts `register()` reaches the heartbeat write; a lint or test grep asserts no bare `process.` access in `ai-sdlc-plugin/hooks/hierarchy/` outside strings handed to `process.run`.

## Acceptance Criteria
- [ ] #1 `register()` completes under a scope without a `process` global and writes `module-<session>.json`.
- [ ] #2 `resolveBoardDir` still honours an absolute `boardDir`, then `CLAUDE_PROJECT_DIR` (now supplied by the caller), then the cwd root lookup, in that order; the AISDLC-1181 tests still pass.
- [ ] #3 A test fails on any bare `process.` reference in `ai-sdlc-plugin/hooks/hierarchy/*.ts*` outside the child-process script strings.
- [ ] #4 PR body states the follow-up the operator runs after landing: `cli-hierarchy down --role operator-dispatch` then `up` in each hierarchy, and restart running executors.
