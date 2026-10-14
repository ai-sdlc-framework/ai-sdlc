---
id: AISDLC-894
title: 'feat(hierarchy): dispatch tick lands every eligible own-author PR through merge-if-eligible, squashing at once when GitHub auto-merge is unavailable'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [hierarchy, governance, velocity, adopters]
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - .ai-sdlc/agent-role.yaml
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Context

Request from the ai-sdlc-io planner session on 2026-10-14 (recorded there as ai-sdlc-io DEC-0008; operator words: "we can't have PRs accumulating like that we need PRs to merge as soon as they are green and clean"). Private repositories on the GitHub Free plan have no branch protection, no native auto-merge and no CodeQL, so PRs that are green and clean sit open until a person merges them.

Verified in `pipeline-cli/src` (2026-10-14):

- `cli-merge-if-eligible` is only ever invoked from command and agent prose (`rebase.md`, `ci-conflict-resolver.md`, `resolve-conflicts.md`). No non-test module calls `runMergeIfEligible` (`governance/merge-if-eligible.ts:1379`): not `runDispatchTick` (`hierarchy/dispatch-loop.ts:409`), not `watchVerdicts` (`dispatch-loop.ts:257`), not next-step.
- The only PR survey on the tick path is `mark-ready.ts`. `hierarchy/pr-state.ts` (`classifyPr`, `classifyAndRecord`) is called only from `cli/dispatch.ts`.
- `--arm` (`armPr`, `governance/merge-if-eligible.ts:1220-1244`) uses GitHub native auto-merge, which a private Free-plan repo cannot enable. `mergePr` (L1189-1212) performs the immediate merge with the same policy checks.

**Five-step review (requirements first).** Requirement questioned: "a human or a prose-driven agent step runs merge-if-eligible". The merge decision is already fully deterministic (policy, author list, fork, base, task id, head sha, checks, CLEAN); only the trigger is missing. Delete: nothing (the prose commands keep working). Simplify: one tick hook, one call per open own-author PR, the same code path as the CLI. Accelerate: a green PR lands on the next tick instead of waiting for a person. Automate: this is the automation, rung 1 of the ladder (deterministic, no model call).

## Fix

1. `hierarchy/dispatch-loop.ts`: add a `landEligiblePrs` step to `runDispatchTick`, after `watchVerdicts` and before `buildReports`. It lists open same-repo PRs whose author is in `governance.mergeAuthors`, and for each calls `runMergeIfEligible` with `sourceKind: 'backlog'` (or the kind derived from the branch; see the decisions-sync landing task for `decisions-sync`). Governance remains the only gate: `allowMerge: onGreenClean`, author list, not a fork, base `main`, green required checks, `mergeStateStatus == CLEAN`.
2. Mode selection: use `armPr` when the repo reports auto-merge available (`gh repo view --json autoMergeAllowed`); when it is `false`, call `mergePr` (immediate squash with `--match-head-commit`). Never add a raw merge call outside `governance/merge-if-eligible.ts`.
3. Gate the step with an operational action `land-eligible-prs` in `agent-role.yaml` `operational:` (same pattern as `mark-ready-after-codeql`, `hierarchy/operational.ts`). Off when absent.
4. Record each outcome on the board: `done/<task-id>.verdict.json` gains `landed: { prNumber, sha, mode: 'armed' | 'merged', at }`; refusals go to `notes/` with the refusal reason, once per PR per head sha (no spam).
5. Docs: `docs/operations/cli-hierarchy.md` tick section and `docs/operations/merge-without-queue.md`.
6. Tests (Vitest): tick with two PRs, one eligible one not; auto-merge available vs unavailable picks `armPr` vs `mergePr`; refusal recorded once; operational action absent means no gh calls.

## Acceptance Criteria

- [ ] #1 `cli-hierarchy tick` with `land-eligible-prs` granted calls `runMergeIfEligible` for every open PR by a `mergeAuthors` author and lands each eligible one (armed when auto-merge is available, immediate squash otherwise).
- [ ] #2 Without the operational action the tick issues no merge or arm call.
- [ ] #3 Every landing writes `landed` into the task verdict; every refusal is recorded once per head sha in `notes/`.
- [ ] #4 No new raw merge invocation of `gh` exists outside `governance/merge-if-eligible.ts` (grep gate in tests).
- [ ] #5 `docs/operations/cli-hierarchy.md` documents the step and the operational action.

**Velocity impact.** Positive: PRs land on the next tick (minutes) instead of waiting for an operator; removes the PR accumulation the site repo reported. No new review or approval step.

Authority: class (a) under `docs/operations/decision-authority.md` (the merge gate itself is unchanged; the trigger is automated behind an operational action). Operator instruction 2026-10-14 ("do them all").
