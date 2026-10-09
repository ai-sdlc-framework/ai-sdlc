# RCA 2026-10-09: a clock-dependent test turned main red and blocked every pull request

**Status:** fix in flight (AISDLC-767, PR #1282). Prevention tasks: AISDLC-768, AISDLC-769, AISDLC-770; AISDLC-484 raised to high.
**Author:** planner session, 2026-10-09. Operator: Dominique Legault.

## Impact

- From 2026-10-08T00:00Z every CI run of `pipeline-cli` failed on one test. Every pull request went red, docs-only ones included (#1278, #1279, #1281, #1282), and `main-health` failed at 4617753a.
- No task could reach `main`, so no executor could claim the fix task: a circular block. Admin merge is not available to the operator or to any agent.
- Nobody was paged. The main-health monitor has never filed an issue.
- About 4 hours of operator and planner time on 2026-10-09, plus the reruns.

## Timeline (UTC)

| When | What |
|---|---|
| 2026-09-30 | `usage.test.tsx` lands with AISDLC-652 (#1123). The "bad ledger line" test writes one record and a `null` line to the ledger file for the fixed timestamp 2026-09-10 and renders the pane with the real clock. |
| 2026-09-30 to 10-07 | The pane loader reads from `now - 168 h` backwards; the September ledger file is inside that range, the bad line throws, the test passes. |
| 2026-10-07 22:23 | `main-health` fails at 19441b66 on a different test (the quadratic ReDoS canary, fixed by #1280). No issue filed. |
| 2026-10-08 00:00 | `now - 168 h` crosses into October. The loader opens only `ledger-2026-10.jsonl`, which does not exist, nothing throws, the pane renders a table. The test fails on every run from here on. |
| 2026-10-08 18:08 | #1278 and #1279 (docs-only filing PRs) go red on Build & Test. Read as a flake. |
| 2026-10-09 ~15:30 | Reruns fail again. Local run on clean main fails 3 of 3 after a fresh `reference` build. Root cause found in `pane-data.ts` `readNeeded()`. AISDLC-767 filed (#1282). |
| 2026-10-09 16:15 | #1260 merges on a Build & Test result that predates the failure onset. `main-health` fails at 4617753a. Issue creation fails: `could not add label: 'ci' not found`. |
| 2026-10-09 ~17:30 | `cli-orchestrator tick --task-from-file` tried twice and aborts at Step 4. Developer dispatched directly on the #1282 branch. Labels `ci` and `main-red` created. |

## Root causes

1. **Clock-dependent test.** `pipeline-cli/src/tui/panes/usage.test.tsx` fixes the data timestamp (2026-09-10) but not the clock. `loadUsagePaneData` has a `deps.now` seam that the test does not use. The test's correctness had a built-in expiry of 28 days from the data timestamp. Nothing in review or CI can see a test that passes today and fails on a calendar date.
2. **Time rot is invisible until a push.** `main-health` runs only on push to `main`. Between 2026-10-07 22:46 (green) and 2026-10-09 16:15 (red) nothing pushed, so the first signal came from unrelated PRs and looked like a flake.
3. **The monitor never paged.** `.github/workflows/main-health-monitor.yml` runs `gh issue create --label "ci,main-red"`; neither label existed in the repository, so the step has failed on every red run since the monitor shipped (AISDLC-406). The runbook says the issue is the primary notification. There is no workflow test asserting the labels exist and no fallback without labels.
4. **Docs-only PRs are gated on the full suite.** Root `package.json` `test` runs `pnpm -r test` and the CI test step is `pnpm --filter "...[origin/main]" test`. A change to `backlog/**` marks the root package changed, so a one-file task filing runs the whole suite. The docs-only fast path has never fired (AISDLC-484, open since 2026-05-30 at medium). This is what turned a test regression into a filing block.
5. **The single-PR escape hatch does not work.** `cli-orchestrator tick --task-from-file` (AISDLC-373) is the documented way to land a task file and its fix in one PR when the task is not on `main`. Step 3 always runs `git worktree add` from `origin/main` and Step 4 looks the task up by id in the worktree or the main checkout, ignoring the override. The runbook procedure cannot succeed for a file that is not on `main`.
6. **Agents cannot reach the dispatch session.** Planner messages to `ai-sdlc-operator-dispatch` are denied by its permission mode. The fallback is a memory file dispatch re-reads after a clear. This cost an hour of routing on an incident that needed minutes.

## What went right

- The failure was deterministic once looked at, and the loader has a `now` seam, so the fix is small.
- `verify-attestation`, governance hooks and the no-admin-merge policy all held; nobody bypassed a gate.

## Prevention (tasks filed)

| Task | Change | Closes cause |
|---|---|---|
| AISDLC-768 (high) | main-health: `schedule` trigger (daily) in addition to push; issue step creates missing labels or files the issue without labels; a workflow test asserts every label the workflow references; a `[main-health]` issue in the last 24 h blocks `cli-merge-if-eligible` arming for non-fix PRs is out of scope and noted as follow-up. | 2, 3 |
| AISDLC-769 (high) | Clock discipline: ESLint `no-restricted-syntax` on `new Date()` / `Date.now()` in `src/**` outside a per-package `clock.ts` seam, warn level with a shrink-only baseline (same ratchet as dark-code; 248 call sites today); vitest convention of `vi.useFakeTimers` or a `now` seam whenever a test fixes a timestamp; test-reviewer checklist line "a test that fixes a timestamp must also fix the clock" with a Velocity impact section per DEC-0048. | 1 |
| AISDLC-770 (high) | `--task-from-file` honours the given path in Steps 3 and 4 (reuse an existing worktree, copy the file into a fresh one), hermetic test for a task file that is not on `main`, runbook corrected. | 5 |
| AISDLC-484 (raised to high) | Docs-only fast path: `backlog/**`, `docs/**`, `spec/rfcs/**` and root markdown skip Build & Test, Coverage and Integration. | 4 |
| Done today | Labels `ci` and `main-red` created; paging works from the next red run. | 3 |

Cause 6 is covered by AISDLC-766 (continuous handoff) and the dispatch Sonnet restart; a direct planner-to-dispatch channel that does not depend on permission mode is noted for the planner, not filed here.

## Lessons

- "Flaky" is a hypothesis, not a diagnosis. Run the failing test locally on clean `main` before rerunning CI.
- Every test that fixes a timestamp is a test with an expiry date unless it also fixes the clock.
- A monitor that has never fired is untested. Assert the resources an alert path needs.
- The repository needs one working path to land a fix when `main` is red that does not depend on `main` being green. AISDLC-770 is that path.
