---
id: AISDLC-685
title: >-
  Stop-hook coverage check must not run concurrently, must not run workspace-wide, and must kill its whole process group on timeout
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - hooks
  - plugin
  - operations
dependencies:
  - AISDLC-666
references:
  - ai-sdlc-plugin/hooks/deferred-coverage-check.js
  - ai-sdlc-plugin/hooks/deferred-coverage-check.test.mjs
  - vitest.parent-watch.setup.mjs
  - scripts/vitest-parent-death.test.mjs
  - vitest.shared.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-directed through rfc-planner 2026-10-03. The `Stop` hook
`deferred-coverage-check.js` runs workspace-wide `pnpm test:coverage` whenever any
`.ts`/`.js` file is dirty, in every session, at the end of every turn. With several
sessions open the machine reached a load of 91; the hook's `execSync` timeout kills only
the shell, so vitest workers are orphaned and keep running. A wall-clock test in
`@ai-sdlc/reference` (`secret-redact.test.ts` ReDoS) then fails under that load and the hook
reports it as a coverage failure.

## Conventions
- Plugin hooks use `node --test` with hermetic fixtures (temporary git repos, temporary
  `HOME`, temporary lock directory); no reads of the real home directory.
- Tests must run on Linux as well as macOS: no `/dev/stdin` reads in tests; feed the hook
  its stdin through a pipe.
- Behaviour for an adopter's single-package repository stays as today.

## Scope
Files: `ai-sdlc-plugin/hooks/deferred-coverage-check.js` and its test file, and
`vitest.parent-watch.setup.mjs` with `scripts/vitest-parent-death.test.mjs`.

1. **Machine-wide single-flight lock:** a lockfile under `os.tmpdir()` holding the holder's
   pid and start time. When a live holder exists the hook exits 0 silently. A lock whose
   pid is dead (or whose pid was reused by a process started at another time) is stale and
   is taken over.
2. **Own process group, always reaped:** the coverage command is spawned detached in its
   own process group. On timeout, and on any other exit path, the hook kills the whole
   group with `process.kill(-pid)` and then exits 0 with the existing advisory. No child
   outlives the hook. The lock is released on every exit path.
3. **Changed packages only:** the dirty source paths are mapped to workspace packages and
   the run passes one `--filter` per affected package instead of `pnpm -r`. When the
   mapping fails, the hook skips; it never falls back to a workspace-wide run.
4. **Env skip:** the hook exits 0 without running anything when
   `AI_SDLC_SKIP_DEFERRED_COVERAGE=1`. The role-based skip (RFC-0051 executor and
   operator-dispatch sessions) is out of scope here per DEC-0022 and is carried by
   the executor-role enforcement follow-up.
5. **Worker ceiling:** the child environment sets `AI_SDLC_VITEST_MAX_WORKERS=2`.
6. **Watchdog termination:** vitest replaces `process.exit` inside workers with a function
   that throws, so the AISDLC-681 watchdog in `vitest.parent-watch.setup.mjs` must end the
   worker with `process.kill(process.pid, 'SIGKILL')`. A test proves that a worker running
   a busy test file dies after its parent is SIGKILLed.

## Acceptance Criteria
- [x] Two hook invocations started together result in exactly one coverage run.
- [x] After a forced timeout, no process from the run's group is alive within 5 s.
- [x] A dirty file in one package runs coverage for that package only.
- [x] role skip deferred to the executor-role enforcement follow-up (after AISDLC-666)
- [x] With AI_SDLC_SKIP_DEFERRED_COVERAGE=1 the hook runs nothing.
- [x] node --test hook tests cover each of these.
- [x] Linux-portable: no /dev/stdin reads in tests.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
The Stop-hook coverage check now takes a machine-wide single-flight lock, runs coverage only for the workspace packages that contain dirty source files, and spawns the command in its own process group that is SIGKILLed on every exit path. The vitest parent-death watchdog now terminates with SIGKILL on itself.

## Changes
- `ai-sdlc-plugin/hooks/deferred-coverage-check.js` (modified): env skip, fd-0 stdin, lock (O_EXCL + guarded stale takeover), dirty-path to package mapping, detached spawn with own timeout, group kill + lock release on all exits, `AI_SDLC_VITEST_MAX_WORKERS=2`.
- `ai-sdlc-plugin/hooks/deferred-coverage-check.test.mjs` (modified): hermetic tests for each behaviour.
- `vitest.parent-watch.setup.mjs` (modified): `process.kill(process.pid, 'SIGKILL')` instead of `process.exit(1)`.
- `scripts/vitest-parent-death.test.mjs` (modified): busy-worker parent-death test.

## Design decisions
- **Mapping failure skips**: a root-level file in a workspace repo is unmappable and skips; never workspace-wide.
- **Takeover guard**: stale takeover happens under a mkdir guard so exactly one of several racing hooks proceeds.

## Verification
- `node --test ai-sdlc-plugin/hooks/deferred-coverage-check.test.mjs` - 25 pass
- `node --test scripts/vitest-parent-death.test.mjs` - 4 pass

## Follow-up
(none)
