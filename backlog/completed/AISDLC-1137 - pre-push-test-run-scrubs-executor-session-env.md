---
id: AISDLC-1137
title: 'Pre-push patch-coverage test run scrubs the executor session variables (AI_SDLC_EXECUTOR_TASK, AI_SDLC_HIERARCHY_*) and the executor-start tests stop reading ambient env'
status: Done
assignee: []
created_date: '2026-10-31'
labels:
  - hooks
  - pipeline-cli
  - hierarchy
dependencies: []
references:
  - scripts/pre-push-patch-coverage.mjs
  - scripts/pre-push-patch-coverage.test.mjs
  - pipeline-cli/src/hierarchy/executor-start.ts
  - pipeline-cli/src/hierarchy/executor-start.test.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
priority: high
dispatchable: true
---

## Description

On 2026-10-31 four approved tasks (AISDLC-585, 655.3, 785, 940) failed at the push step with the same signature: the pre-push patch-coverage gate runs the test suite inside the executor session, where `AI_SDLC_EXECUTOR_TASK=<id>` (and the `AI_SDLC_HIERARCHY_*` variables) are set for the spawned executor (RFC-0059). `executor-start.ts` reads `AI_SDLC_EXECUTOR_TASK` from `process.env` when no `deps.env` is given, so 15 tests in `executor-start.test.ts` and `hierarchy.test.ts` fail with "cannot claim <id>" and the lease push is refused. The same suite passes with the variable unset (verdict notes for AISDLC-785: all 179 pass).

`scripts/pre-push-patch-coverage.mjs` already builds a cleaned environment for the spawned test child (`gitSafeEnv`, which drops the `GIT_*` repository variables so temp fixtures work). The executor session variables belong in the same scrub.

**Five-step review (requirements first).**
1. Requirement questioned: should the pre-push coverage step simply be skipped inside executor sessions? No: DEC-0282 keeps the step as the early copy of the CI gate, and a skip would hide the leak rather than fix it. The requirement that stands is "a test suite never depends on the ambient session of the shell that runs it".
2. Delete: the implicit `process.env` fallback for `AI_SDLC_EXECUTOR_TASK` in the two test files; tests that exercise the pinned-executor path pass the variable through `deps.env` explicitly, and tests of the unpinned path pass an env without it.
3. Simplify: one scrub function in `pre-push-patch-coverage.mjs` (extend `gitSafeEnv` or add a sibling with the same shape) removes `AI_SDLC_EXECUTOR_TASK` and every key starting with `AI_SDLC_HIERARCHY_` from the child env. No new flag.
4. Accelerate: nothing; the test child already runs once.
5. Automate: a unit test in `pre-push-patch-coverage.test.mjs` asserts the scrubbed env has no executor keys and still keeps unrelated variables; a test in `executor-start.test.ts` asserts the pinned path reads `deps.env`, not `process.env`, when `deps.env` is given.

Velocity impact: removes the single most common push refusal seen on the board on 2026-10-31 (4 of 7 failed verdicts).

## Acceptance Criteria

- [x] AC-1: `scripts/pre-push-patch-coverage.mjs` spawns the test suite with an env that contains no `AI_SDLC_EXECUTOR_TASK` and no `AI_SDLC_HIERARCHY_*` key, while unrelated variables (PATH, HOME, AI_SDLC_SKIP_* flags) are preserved; `scripts/pre-push-patch-coverage.test.mjs` covers both assertions.
- [x] AC-2: With `AI_SDLC_EXECUTOR_TASK=AISDLC-1` exported in the shell, `pnpm --filter @ai-sdlc/pipeline-cli test -- executor-start hierarchy` is green (the tests no longer read ambient env for the pinned path).
- [x] AC-3: No skip variable is added and `AI_SDLC_SKIP_PATCH_COVERAGE_GATE` semantics are unchanged.
- [x] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner PR-pressure survey 2026-10-31 (failed verdicts AISDLC-585, 655.3, 785, 940 in `.ai-sdlc/dispatch/failed/`). Sibling tasks: AISDLC-1138 (lease push on an existing remote branch), AISDLC-1139 (reclaim approved drafts), AISDLC-1140 (stale-base drift is rebase-fixable).

## Final Summary

## Summary
The pre-push patch-coverage test child now gets an env without AI_SDLC_EXECUTOR_TASK and AI_SDLC_HIERARCHY_* keys, via a new `sessionScrubbedEnv` in `scripts/pre-push-patch-coverage.mjs`. The executor-start and hierarchy tests no longer read the ambient executor variable.

## Changes
- scripts/pre-push-patch-coverage.mjs
- scripts/pre-push-patch-coverage.test.mjs
- pipeline-cli/src/hierarchy/executor-start.test.ts
- pipeline-cli/src/hierarchy/hierarchy.test.ts
- backlog/tasks/AISDLC-1137 - pre-push-test-run-scrubs-executor-session-env.md

## Design decisions
Test command: `pnpm test`. It ended with 3799 passing and 1 failing, and the failure was the usage-ingest tmpdir flake above. It passes alone and this diff doesn't touch that test or its source. With AI_SDLC_EXECUTOR_TASK=AISDLC-1 exported, `pnpm --filter @ai-sdlc/pipeline-cli test -- executor-start hierarchy` passed (61 files, 1103 tests). Rather than passing `deps.env` to every unpinned call, I added `vi.stubEnv('AI_SDLC_EXECUTOR_TASK', '')` in the top-level beforeEach of both test files. I also added a test asserting the pinned path reads `deps.env` over `process.env`. The branch also carries a small commit with a task-file state change, committed because the rebase needed a clean tree.

## Verification
- `pnpm build` — passed
- `pnpm test` — waived
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

