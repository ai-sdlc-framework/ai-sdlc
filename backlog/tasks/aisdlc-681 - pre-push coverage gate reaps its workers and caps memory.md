---
id: AISDLC-681
title: >-
  Pre-push coverage gate must reap its vitest workers on exit and cap concurrent test memory
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - ci
  - hooks
  - tests
  - operations
dependencies: []
references:
  - scripts/check-coverage.sh
  - .husky/pre-push
  - docs/operations/parallel-dispatch.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-filed 2026-10-02 after a near out-of-memory on the operator machine. Forty-six
orphaned `node (vitest N)` workers, parent pid 1, 10 to 15 minutes old, were holding
about 12.8 GB. They were left behind by `scripts/check-coverage.sh`, the pre-push
coverage gate, whose `pnpm --filter "...[origin/main]" test:coverage` run had been
interrupted (session exit, hook timeout, or a failed earlier step) without its vitest
worker processes being killed. With five executor sessions pushing in the same window
the live runs multiplied on top of the orphans. Recovery required killing the orphans
by hand; a crash would have cost the whole day's session state.

Two defects, both to fix here:

1. **Workers outlive the gate.** The script starts pnpm in the foreground with no
   process-group handling and no `trap`. When the hook is killed (timeout, Ctrl-C,
   parent session exit) pnpm dies but the vitest worker pool is reparented to pid 1
   and keeps running to completion or forever.
2. **No memory ceiling.** Each package's vitest run spawns a worker per CPU and the
   affected-package filter still runs the whole workspace for any cross-cutting
   change (a push that touches `reference/` is cross-cutting for most packages).
   Several concurrent pushes therefore run several full workspace suites at once.

## Conventions
- Shell scripts stay POSIX-compatible with bash on macOS and Linux; test with
  `node --test` harnesses that spawn the script against a fixture repo, as the other
  `scripts/*.test.mjs` do.
- No `AI_SDLC_SKIP_*` tokens; the gate's threshold and affected-package logic are
  unchanged.

## Scope
1. **Reaping:** run the coverage command in its own process group (`setsid` where
   available, else a `node` wrapper using `detached: true` plus `process.kill(-pgid)`)
   and install `trap` handlers for EXIT, INT, TERM and HUP that kill the whole group.
   A hook killed mid-run leaves zero `vitest` processes behind within 5 seconds.
2. **Timeout:** the coverage run has a hard wall-clock limit (default 15 minutes,
   `AI_SDLC_COVERAGE_TIMEOUT_SEC` to adjust) after which the group is killed and the
   gate fails with a clear message; a timeout is never a pass.
3. **Memory cap:** pass a worker ceiling to vitest for the gate run (`--maxWorkers`,
   default `min(4, ncpu/2)`, `AI_SDLC_COVERAGE_MAX_WORKERS` to adjust) and
   `--pool=forks` only if the suite already uses it; do not change the CI
   configuration.
4. **Concurrency guard:** a repository-wide lock under the main checkout's
   `.ai-sdlc/` runtime state (not the worktree) so concurrent pushes from sibling
   worktrees queue instead of running the gate in parallel; a stale lock older than
   the timeout is reclaimed. The waiting push prints who holds the lock.
5. **Doctor:** `doctor` reports orphaned `vitest` processes with parent pid 1 older
   than two minutes as a warning with the kill command.
6. **Docs:** the parallel-dispatch runbook gains a "pre-push gate resource use"
   paragraph with the env vars and the lock behaviour.

## Acceptance Criteria
- [ ] Killing the pre-push hook process with SIGTERM or SIGINT during the coverage run leaves no `vitest` process alive after 5 seconds (test spawns the script against a fixture package with a sleeping test).
- [ ] A coverage run exceeding the timeout is killed as a group and the gate exits non-zero with the timeout named.
- [ ] The vitest invocation carries the worker ceiling, defaulting to `min(4, ncpu/2)`, overridable by env.
- [ ] Two gate runs started concurrently from sibling worktrees serialise on the lock; a stale lock is reclaimed.
- [ ] `doctor` warns on orphaned vitest workers and is quiet when there are none.
- [ ] Runbook paragraph present; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
