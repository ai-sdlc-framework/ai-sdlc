---
id: AISDLC-1062
title: 'hierarchy hooks module version guard reads the object $.session.version() returns, so a current host is no longer refused as below the floor'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - plugin
  - hierarchy
  - rca-2026-10-23
priority: critical
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - docs/operations/cli-hierarchy.md
---

## Description

Smoke test after the 0.36.x restart (2026-10-23 17:00Z): `claude plugin validate` passes and the module now loads in every roster session, but no session registers. The module's own log in the plugin store holds the same line eight times, once per session start:

```
[hierarchy] not registering: Claude Code [object Object] is below the floor 2.1.307 (session.version)
```

Cause: `$.session.version()` on Claude Code 2.1.309 resolves to an object, `{ version: { VERSION: "2.1.309", BUILD_TIME, GIT_SHA, PACKAGE_URL, ... } }`, not a string. `parseVersion` in `ai-sdlc-plugin/hooks/hierarchy/executor.ts` does `String(v)` and matches `\d+.\d+.\d+` on `[object Object]`, so `atLeast` is false and `guard` refuses every role. Effect: no dispatch tick, no rotate-request consumption, `cli-hierarchy clear <executor>` fails with "no hooks module consumed it", and every executor clear is manual. Same symptom as the validator refusal fixed by the previous plugin task, different cause.

Fix: `parseVersion` accepts a string or the host object. Read, in order, `v.version.VERSION`, `v.version` (when a string), `v.VERSION`, then the string form; only then apply the regex. Never regex over `JSON.stringify` of the object (the build date also matches). The refusal line prints the extracted string, or the top-level keys when none is found, never `[object Object]`. Add unit tests for `parseVersion`/`atLeast`/`guard` with the string form, the 2.1.309 object form, an object without a version, `null`, and a version below the floor; the test runner for plugin hooks is `node --test`, so put a test file beside the module that imports the compiled or transpiled helpers the way the existing hook tests do, or move the pure helpers into `ai-sdlc-plugin/hooks/lib/` if that is the only way to test them without a TypeScript step. Update the runbook entry for "no module loaded" in `docs/operations/cli-hierarchy.md` to name this log line and its meaning.

**Five-step review (requirements first).** Requirement questioned: is a version floor needed at all when every primitive is probed anyway? Kept: a floor gives one readable line instead of five probe failures, but it must never block a newer host. Deletion: nothing. Simplified: one accessor that normalises the host value to a string before the existing regex. Accelerated: the smoke test passes on the first `up` after the plugin reload. Automated last: unit tests pin the object shape so a future host change fails in CI, not in production.

## Acceptance Criteria

- [ ] `guard({ version: { VERSION: '2.1.309' } }, present)` returns null; `guard('2.1.309', present)` returns null; `guard({ version: { VERSION: '2.1.300' } }, present)` and `guard(null, present)` return the refusal line, and that line never contains `[object Object]`.
- [ ] After `claude plugin validate ai-sdlc-plugin` passes and the hierarchy is restarted, the plugin store log shows `role=operator-dispatch` registration for the dispatch session and `cli-hierarchy clear ai-sdlc-executor-alpha` run from the dispatch session is acknowledged (rotate request consumed).
- [ ] Runbook updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
