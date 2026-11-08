---
id: AISDLC-1232
title: reconciler reruns a stale verdict-check when the head already carries an approved verdict ref
status: Done
priority: high
labels: [bug, pipeline-cli, dispatch, throughput]
dependencies: []
dispatchable: true
---

## Problem

2026-11-07, PR #2521 (AISDLC-731): the developer round pushed head c7f628b4 at 21:48Z and the gate run 42417819496 ran its `verdict-check` job at 21:52Z, before any review had finished. The three reviewers approved at 22:03Z and Step 11 pushed `refs/ai-sdlc/verdicts/c7f628b4...` at 22:05Z. Nothing re-ran the gate: a ref push does not trigger the `pull_request` workflow, so `Review verdict (code PRs)`, `ai-sdlc/attestation` (`no-record no verdict ref for this head`) and `ai-sdlc/pr-ready` stayed red on a head whose verdict is valid. The reconciler classified it `real-failure` and tried `reenter` twice, which refused because the executor's board verdict had been lost to the pane-exit requeue (AISDLC-1230); the PR then waited for a planner wake, and the planner had to order a hand-typed `gh run rerun`.

The reenter route table (`hierarchy/reenter.ts:277-293`) knows `rerun` only for `cancelled-or-infra`; `hierarchy/pr-state.ts` has no state for "check predates the verdict ref". Any PR whose reviews finish after the gate run without a new commit hits this.

## Fix

**Five-step review (requirements first).**
1. Question: a head that carries a valid verdict ref must never wait on a person for its gate to turn green; the only thing missing is a re-run of a job that read stale state.
2. Delete: the `reenter` attempts and the planner route for this shape; an executor round cannot help, the code is already approved.
3. Simplify: in `pr-facts` read `git ls-remote origin refs/ai-sdlc/verdicts/<head>`; when the ref exists and the gate run's `verdict-check` job completed before the ref's commit time (or with `no-record`), classify the PR `stale-verdict-check`, map it to the existing `rerun` route (`gh run rerun <run> --failed`, resolved through `gate-run.ts`), and record it in the landing record like any re-entry.
4. Accelerate: one rerun per head; a second `stale-verdict-check` on the same head routes to the planner through the existing same-head guard.
5. Automate last: tests below.

## Acceptance Criteria

- [x] #1 Test: a task PR with `ai-sdlc/pr-ready` FAILURE whose head has a verdict ref newer than the `verdict-check` job completion is classified `stale-verdict-check` and the reconciler issues `gh run rerun <gate run id> --failed` once, recording `rerun` in `landing/<pr>/reentered.json`.
- [x] #2 Test: the same head with no verdict ref keeps today's `real-failure` classification and action.
- [x] #3 Test: a second stale classification on the same head (the rerun did not turn green) routes to the planner with reason `stale-verdict-check@2`, no second rerun.
- [x] #4 `docs/operations/cli-hierarchy.md` and the pr-state table name the new state and its action in one line each.

## Notes

Evidence: `.ai-sdlc/dispatch/log/reconcile.log` entries for #2521 at 22:06Z (`real-failure`, `reenter` failed x2); `refs/ai-sdlc/verdicts/c7f628b49f77b8f5cd3e4edff03c011d94cc55e8` (commit by ai-sdlc-step-11, 22:05Z); gate run 42417819496 jobs 128539654897 (verdict-check 21:52Z). Companions: AISDLC-1230 (verdict lost at phase done, second occurrence here), AISDLC-1231 (CI failure rounds carry the log).

## Final Summary

## Summary
Added a `stale-verdict-check` PR state. When `pr-ready` and the `Review verdict (code PRs)` job are red and the head's verdict ref commit is newer than that job's completion, the reconciler reruns the gate's failed jobs once and records `rerun` in `landing/<pr>/reentered.json`. A second stale classification on the same head routes to the planner with `stale-verdict-check@2`. A head with no verdict ref stays `real-failure`.

## Changes
- pipeline-cli/src/hierarchy/pr-state.ts
- pipeline-cli/src/hierarchy/reconcile.ts
- pipeline-cli/src/hierarchy/reenter.ts
- pipeline-cli/src/hierarchy/reconcile.test.ts
- docs/operations/cli-hierarchy.md

## Design decisions
I ran build, lint and format:check on the full repo. I ran the tests only for `src/hierarchy` (1179 passed), not the whole suite. The `readGuard`, `recordGuard` and `GuardEntry` helpers moved from `reenter.ts` to `reconcile.ts` so both files share them without an import cycle. Staleness is checked in `gatherFacts` through two `gh api` calls, which read the verdict ref and then its commit date. Any lookup failure counts as not stale, so the PR stays `real-failure`. The pr-state table lives in `cli-hierarchy.md`, so the one-line row there covers the AC4 doc requirement.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

