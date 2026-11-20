---
id: AISDLC-1361
title: 'One bootstrap test takes a scratch repository from setup to a merged pull request and fails when any stage is skipped'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - test
  - adopter
  - bootstrap
dependencies:
  - AISDLC-1351
  - AISDLC-1352
  - AISDLC-1353
  - AISDLC-1354
  - AISDLC-1355
  - AISDLC-1356
  - AISDLC-1357
  - AISDLC-1358
  - AISDLC-1359
  - AISDLC-1360
references:
  - scripts/first-run-smoke.mjs
  - scripts/first-run-smoke.test.mjs
  - scripts/first-run-smoke-pipeline.mjs
  - .github/workflows/ci.yml
  - .github/workflows/__tests__/first-run-smoke.test.mjs
  - package.json
  - orchestrator/src/cli/commands/setup.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/next-step/verdict-ref-push.ts
  - pipeline-cli/src/cli/hierarchy.ts
priority: high
dispatchable: true
dispatchableReason: 'A new sibling script with a stateful gh stub, wired to the nightly job; it lands after the ten tasks it asserts; the stages hold for either answer to the merge-default question of AISDLC-1351.'
---

## Description

**Gap.** Nothing in CI takes a new repository from setup to a merged pull request, so each of the faults found on 2026-11-19 (an empty merge-author list that lands nothing without a word, a branch protection that waits for a check nobody posts, a dispatch module that cannot find its CLI) reached an operator first.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly. This test is the proof, and the way the requirement stays true.

**Cause (read from the source on main).** The existing first-run smoke covers a part of the path.

- It runs `init --yes`, not `setup` (`scripts/first-run-smoke.mjs:265-282`). `setup` is a separate command (`orchestrator/src/cli/commands/setup.ts`, registered at `orchestrator/src/cli/index.ts:90`).
- Its `gh` is a script on `PATH` that prints "offline" and exits 1 (`first-run-smoke.mjs:151`), so it can prove nothing that needs GitHub. Its pipeline leg uses a separate runner that answers every `gh` call with empty output and a fixed pull request address (`scripts/first-run-smoke-pipeline.mjs:32-41`).
- It runs doctor and fails on `fail` results only (`first-run-smoke.mjs:284-306`); a check that returned nothing is invisible (AISDLC-1356 makes that visible).
- It files one task, runs the orchestrator tick with a mock spawner and the pipeline to a pushed branch (`first-run-smoke.mjs:307-347`). It never opens a pull request, writes a review verdict, evaluates the merge gate, runs `cli-hierarchy up` or runs the landing pass.
- Its steps are read from the README block and checked in both directions (`first-run-smoke.mjs:352-380`), so adding stages to it would force README steps that do not exist.
- The nightly run is the `first-run-smoke` job in `.github/workflows/ci.yml:165-192` (schedule at `ci.yml:11-12`), which runs `node scripts/first-run-smoke.mjs`. The same script also runs in the gate job `ai-sdlc-gate.yml:549-569`.
- `cli-hierarchy up` has no dry-run or headless option (`pipeline-cli/src/hierarchy/up.ts:67-100` lists its options). It launches `claude` sessions in tmux. `check-repo` exists (`pipeline-cli/src/cli/hierarchy.ts:1664`) and `runHierarchyCli(argv, deps, extras)` accepts injected `run` functions (`hierarchy.ts:635`), which the hierarchy tests use for tmux.
- The landing pass returns an empty report, without a word, when the merge-author list is empty (`pipeline-cli/src/hierarchy/land-eligible.ts:94-96`).

**Shape.** A sibling script, `scripts/bootstrap-smoke.mjs`, reuses the sandbox of the first-run smoke (a temporary repository with a bare origin and an isolated HOME) and replaces its `gh` with a stateful fake, `scripts/bootstrap-smoke-gh.mjs`, that answers the calls the CLIs make from a small state file and records every call. It runs stages in order. Each stage prints `[bootstrap-smoke] stage <n> <name>` when it starts and `ok` when it passes. A final check compares the stages that ran with the list and fails when one is missing. The nightly job runs it after the first-run smoke.

Stages:

1. `setup`: `ai-sdlc setup` (not `init`) in the scratch repository.
2. `prerequisites`: every file and folder `setup` is meant to create exists: the `.ai-sdlc` files, the agent role with merge settings, `backlog/tasks/`, the gate workflow, the verification file.
3. `doctor`: zero `fail`, and every check id in the registry appears in the report (no silent skip).
4. `up`: `cli-hierarchy up` run in-process with injected `run` functions for tmux and the claude launcher. The stage passes when, with the operator inputs supplied, it prints no `warning:` line and no missing-piece line. Real sessions are not started.
5. `task picked up`: a task file in `backlog/tasks/` is found by the orchestrator tick (as today) and ingested by `cli-hierarchy tick` into the board queue (the second part is inferred from the CLI, unverified).
6. `pull request opened`: the mock pipeline pushes the branch and the fake `gh` records a `pr create` for it.
7. `review verdict record`: a record exists under `refs/ai-sdlc/verdicts/` for the head commit (the writer is `pipeline-cli/src/next-step/verdict-ref-push.ts`; which offline step writes it is unconfirmed, inferred, unverified).
8. `merge gate`: `cli-merge-if-eligible <pr> --source-kind backlog` (no `--arm`) against the fake `gh` reports eligible.
9. `landing`: the landing pass (`landEligiblePrs`) lists the pull request as landed and the fake `gh` records the merge call. An empty report fails the stage.

Operator inputs. Some pieces only an operator supplies: the webhook secret variable and, when the scaffold default is merging off (the open question of AISDLC-1351), the three merge keys in `agent-role.yaml`. For each such piece the test first runs the stage without it and asserts the line that names the missing piece and its fix (from `up`, `status` or the landing note), then supplies it as an operator would and asserts the stage passes. When the scaffold default is merging on, the merge keys need no edit and only the assertion that they were written runs. The test therefore holds for either scaffold default.

What the fake can and cannot prove. It proves the CLIs' own logic: the scaffolded files agree with each other, the merge gate and the landing pass accept a green pull request under the scaffolded settings, and no stage returns quietly. It cannot prove real branch protection, real repository secrets, the "Allow auto-merge" setting, that GitHub posts the checks the scaffold requires, or that the canned answers match the live API. A call the fake does not know fails the stage, so a new `gh` call in the CLIs is caught here; the answers themselves are canned and can drift from the live shape.

**Control.** Does not change a control. It adds a test that reads the scaffold and the merge path; it grants no permission and the fake `gh` never leaves the temporary directory.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should the new test extend the README-driven smoke? No; the README block lists `init`, and its two-way check would force README steps for stages a reader does not run by hand. 2. Deleted: the idea of a second always-failing `gh`; the sibling uses one fake for every stage. 3. Simplified: one fake `gh` with a state file and a call log, one stage table. 4. Accelerated: runs after the first-run smoke in the same nightly job, reusing its sandbox and build, and stays under the same five-minute budget. 5. Automated: the final check fails on a skipped stage, and a test seam forces a skip to prove it.

- Export the sandbox builder and helpers from `scripts/first-run-smoke.mjs` (behaviour unchanged).
- Add `scripts/bootstrap-smoke.mjs` and `scripts/bootstrap-smoke-gh.mjs`.
- Add a `smoke:bootstrap` script to `package.json` and a step to the nightly job in `.github/workflows/ci.yml`; the workflow test (`.github/workflows/__tests__/first-run-smoke.test.mjs`) asserts the step.
- Add a hermetic test of the stage table and the skip detection (`scripts/bootstrap-smoke.test.mjs`, a sibling of `scripts/first-run-smoke.test.mjs`).

**Planner reading (class (a), no control effect; the operator may overrule).** This task wires the test to the nightly job and manual dispatch only. Running it on pull requests that touch the scaffold, as the first-run smoke does through the gate job (`ai-sdlc-gate.yml:549-569`), is a later change once the nightly run has been green for a week.

Out of scope: real branch protection, real secrets, the "Allow auto-merge" and "Actions may approve" settings, real `claude` sessions and tmux panes, any change to the CLIs under test (the ten tasks it depends on make those).

## Acceptance Criteria

- [ ] #1 `node scripts/bootstrap-smoke.mjs` on a clean checkout prints the nine stage names in the order above, each followed by `ok`, and exits 0.
- [ ] #2 A test with a seam that skips one stage makes the script exit non-zero and name the stage that did not run, for each of the nine stages.
- [ ] #3 A test shows stage 2 fails when any one scaffolded prerequisite is removed before the stage (checked for the merge settings, `backlog/tasks/` and the gate workflow).
- [ ] #4 A test shows stage 3 fails when a registry check returns no result, and when doctor reports one `fail`.
- [ ] #5 A test shows stage 4 fails when `up` prints a `warning:` line.
- [ ] #6 A test shows that with an empty merge-author list stage 9 does not pass on an empty landing report: the run must show the landing note naming `mergeAuthors`, and the stage passes only after the keys are set and the pull request lands.
- [ ] #11 A test shows stage 4 without the webhook secret variable shows the `webhook: off` line, and passes once the variable is set.
- [ ] #7 A test shows the fake `gh` fails the stage on a call it does not know, and records every call it does know.
- [ ] #8 The nightly job in `.github/workflows/ci.yml` runs the script after the first-run smoke, and the workflow test fails when the step is removed.
- [ ] #9 The run finishes within the existing five-minute budget of the first-run smoke.
- [ ] #10 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
