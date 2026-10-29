---
id: AISDLC-1113
title: >-
  decisions CLI tests must not notify live hierarchy sessions (escalate tests send "DEC-0003 needs an answer" to the real planner over tmux on every suite run)
status: Done
assignee: []
created_date: '2026-10-29'
labels:
  - decisions
  - tests
  - stability
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.test.ts
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/src/decisions/escalation-chain.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since 2026-10-29 07:00Z the planner session receives "Decision DEC-0003 (design) needs an answer. Read it with: cli-decisions show DEC-0003" several times an hour. The real DEC-0003 has been answered since 2026-10-07 and has no escalation tier, so the promotion path in `escalation-chain.ts` can never select it; the earlier fix (sorting events by timestamp in the projection, landed this morning) touched that path and had no effect on the notices.

The sender is a test. The `--route` test in `pipeline-cli/src/cli/decisions.test.ts` (added with the tier-filter work this morning) calls `buildDecisionsCli()` without injecting a `chain`, seeds a temporary store, then runs `escalate --route operational` and `escalate --route design`. The escalate path falls back to `createSystemChainDeps`, which resolves the real roster from the process cwd and sends through real tmux. Each suite run therefore opens a throwaway DEC-0002 and DEC-0003 in a temp folder and notifies the live dispatch and planner sessions about them. Executors run the suite in every task worktree, hence the cadence. The message names an id but not the store it came from, so the recipient cannot tell a fixture decision from the catalog one.

**Five-step review (requirements first).** The requirement questioned is "the escalate command may pick the system chain on its own when the caller injects none": a CLI entry point under test must never reach a live session. Deleted: nothing in production; the silent fallback is what goes. Simplified: `createSystemChainDeps` refuses to send (returns a no-op `send` that records the message) when running under Vitest or `NODE_ENV=test`, and the escalate tests inject a fake chain and assert on the captured messages. Accelerated: the suite no longer shells out to tmux, so the test is faster and hermetic. Automated: a test in the decisions module asserts that no `buildDecisionsCli()` call in the test files runs `escalate --route` or `--park` without an injected chain, and the notice text gains the store path (`workDir`) so a repeat is attributable at a glance.

Fix: guard `createSystemChainDeps` under test, inject a fake chain in every `decisions*.test.ts` escalate test, add the guard test, and append the decision store path to the needs-answer message.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] Running `pnpm --filter @ai-sdlc/pipeline-cli test` inside a task worktree while the hierarchy is up sends no tmux message to any roster session (verify with a tmux `pipe-pane` capture or by asserting `send` is never the system sender under `VITEST`).
- [x] Every `escalate --route` / `--park` test in `pipeline-cli/src/cli/decisions*.test.ts` injects a chain and asserts the captured message instead of relying on the system chain.
- [x] A module test fails if a decisions CLI test file calls `escalate --route` or `--park` without an injected chain.
- [x] The needs-answer notice includes the decision store path so a fixture decision cannot be mistaken for the catalog one.
- [x] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: planner notices 2026-10-29 07:04Z, 16:3xZ and 17:0xZ; `cli-decisions show DEC-0003` in the main checkout shows lifecycle answered (2026-10-07) with no escalation field; the route test was merged 07:25Z, the first burst was seen 07:04Z while it was being developed.

Verification: `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/cli/decisions src/decisions` -> Test Files 36 passed (36), Tests 777 passed (777). Full `pnpm test`: only unrelated failures remain: `scripts/sync-plugin-runtime-deps.test.mjs` (plugin pin drift, fails alone, file untouched by this diff) and a flaky tmpdir cleanup in `ai-sdlc-plugin/hooks/usage-ingest.test.mjs` (passes alone, 18/18, untouched). build, lint, format:check pass.

## Final Summary

## Summary
The decisions CLI tests no longer reach live sessions. `createSystemChainDeps` now uses a recording sender under Vitest or `NODE_ENV=test`, and the `--route` test injects a fake chain. A new guard test fails if a decisions test escalates with `--route` or `--park` without a chain. The needs-answer notice now includes the store path. The full `pnpm test` is not clean: two tests unrelated to this change fail (see notes).

## Changes
- pipeline-cli/src/decisions/escalation-chain.ts
- pipeline-cli/src/cli/decisions.ts
- pipeline-cli/src/cli/decisions.test.ts
- pipeline-cli/src/cli/decisions-escalation.test.ts
- pipeline-cli/src/cli/decisions-no-live-chain.test.ts
- backlog/tasks/AISDLC-1113 - decisions CLI tests must not notify live hierarchy sessions.md

## Design decisions
Test command: `pnpm test`. Its node:test summary line was `# tests 3596 / # pass 3594 / # fail 1 / # todo 1`. The usage-ingest `ENOTEMPTY` tmpdir-cleanup failure showed up in that run but not in a second run; the sync-plugin-runtime-deps failure showed up in both. The vitest run of `src/cli/decisions` and `src/decisions` passed: 36 files, 777 tests. `pnpm build`, `pnpm lint` and `pnpm format:check` passed. I did not run the full-suite waiver check on the sync test beyond confirming it fails alone and fails after the rebase. The task file records the verification and has its ACs ticked. The PR is a draft.

## Verification
- `pnpm build` — passed
- `pnpm test` — waived
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

