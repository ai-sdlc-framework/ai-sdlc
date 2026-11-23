---
id: AISDLC-1378
title: 'Verify runs at most one full test suite per machine and test-spawned tsc counts against the worker budget'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - performance
  - pipeline-cli
  - verify
dependencies: []
references:
  - pipeline-cli/src/runtime/verify-slots.ts
  - pipeline-cli/src/steps/verify-commands.ts
  - scripts/pre-push-patch-coverage.mjs
priority: high
---

## Description

**Gap.** On 2026-11-22 at load average 21 on 12 cores, `ps` showed two vitest runs at once (`.worktrees/aisdlc-1373` `vitest run`, `.worktrees/aisdlc-1375` `vitest run --coverage`) and about 10 `tsc` processes under one of them, several above 130% CPU. The verify slots were meant to bound this.

**Facts read in code** (main at cd53eb237).

- `verify-slots.ts:16-18`: `VERIFY_SLOT_COUNT = 2`, `VERIFY_WORKERS_ALONE = 4`, `VERIFY_WORKERS_SHARED = 2`. Two full suites may run at once by design.
- The worker count bounds vitest's pool, not processes a test spawns itself; some tests spawn `tsc` (seen as children of the vitest pool), so the real fan-out is far above 2 to 4.
- `scripts/pre-push-patch-coverage.mjs:92-119`: when the slot wait times out, or the slots module is not built, the coverage run goes **unslotted**.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: two executors must make progress without starving the machine; a full suite needs the whole machine, an affected run (AISDLC-1377) does not. 2. Deleted: the unslotted fallback in pre-push. 3. Simplified: one slot for a full run; affected runs keep the shared two. 4. Accelerated: none needed. 5. Automated: tests on the slot rules.

- A run whose test scope is `full` takes an exclusive slot (both slots); an `affected` run takes one.
- Find the tests that spawn `tsc` (or other heavy children) and either run them serially (`describe.sequential` / a single-thread project) or cap their own concurrency, so one verify run cannot start ~10 compilers.
- `pre-push-patch-coverage.mjs` waits for its slot instead of running unslotted; when the board directory is missing it runs with `VERIFY_WORKERS_SHARED` workers.
- Report the slot holder and scope in `cli-hierarchy status` (`verify slot` line).

## Acceptance Criteria

- [x] #1 A test: a full-scope run cannot start while another verify holds any slot, and blocks new ones while it runs.
- [x] #2 A test: pre-push coverage waits for a slot and never runs unslotted when a board directory exists.
- [x] #3 The tsc-spawning tests are named in the PR body with their new concurrency bound; a local full run shows at most that many `tsc` processes.
- [x] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
I made no code change this round. `ai-sdlc-plugin/hooks/usage-ingest.test.mjs` passes on this branch (18 of 18) in four separate runs, so I judge the CI failure to be a flaky test under load. This branch's diff against origin/main does not touch the usage-ingest hook or its test.

## Changes
- (none)

## Design decisions
I did not reproduce the failing subtest in isolation. The orchestrator's failure likely came from the full gate run executing under heavy parallel load, with timing-sensitive subprocess tests. I only re-ran the usage-ingest test file, not the full gate command, and I skipped build, lint and format because nothing changed since the prior round. If the failure recurs on CI, the usage-ingest test should be investigated as a separate flaky-test task.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 2 reviews approved (harness: correctness-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

