---
id: AISDLC-1231
title: executor retries a CI failure itself with the failing log as the developer note
status: To Do
priority: high
labels: [enhancement, pipeline-cli, dispatch, throughput]
dependencies: []
dispatchable: true
---

## Problem

Throughput analysis 2026-11-07 (41 merged code PRs): the happy path is fast (median 0.6 h dispatch to PR, 0.7 h PR to merge, 8 min CI), but 18 of 41 PRs needed re-entry, 45 rounds in total, and each round costs about 30 minutes of which the fix itself is minutes: the executor delivers, `ai-sdlc/pr-ready` fails, the reconciler either re-enters blind or routes to the planner, the planner wakes (30-minute cadence), reads the failing job log, writes a note under `.ai-sdlc/dispatch/notes/`, orders dispatch, dispatch re-enters. #2413 took 11 rounds and 20 hours; #2496 is on round 7 after 16 hours, every failure a one-line environment fix (missing git, no network, fixture path, corrupt fixture patch) that the log states outright.

Today the reconciler's re-entry only carries `firstFailingLine` (300 chars, `hierarchy/pr-facts.ts:47-51`) and adds `--developer-round` only when `TEST_FAIL_RE` matches (`hierarchy/reconcile.ts:340-371`); otherwise the round is a re-sign with no information, which the same-head guard then turns into `route-to-planner` after one repeat (`loopGuard.maxSameHeadActions`, default 1).

## Fix

**Five-step review (requirements first).**
1. Question: a failing CI check after delivery must reach the developer with enough evidence to act, without a planner turn, as long as the head keeps changing. The planner stays in the loop for the same-head repeat and for anything that is not a check failure.
2. Delete: the blind re-sign. A real-failure re-entry on a task PR is always a developer round.
3. Simplify: the note is built by code from the run, not by a person: for each failed job, the failed step name and the last N lines (default 80, cap 8 KB) of its log from `gh run view <run> --log-failed --job <id>` (already fetched at `pr-facts.ts:79-96`, keep the whole tail instead of one line), plus the head sha and the round number. Written to `<board>/notes/<task>-ci-round-<n>.txt` and passed with `--note-file`, so the executor's developer prompt gets it through the existing `resumeFeedback` path (`next-step/init.ts:157-176`, `steps/05-build-dev-prompt.ts:85-90`).
4. Accelerate: bound it. `loopGuard.maxCiRounds` (default 3, `.ai-sdlc/pr-lifecycle.yaml`): after three automatic CI rounds on one PR, or when the head sha did not change between rounds, route to the planner with the three notes attached, as today.
5. Automate last: tests below.

## Acceptance Criteria

- [ ] #1 Test: a delivered task PR with `ai-sdlc/pr-ready` FAILURE and a changed head gets `reenter --developer-round --note-file <path>`; the note file contains the failed step name, the log tail and the head sha; the queued manifest has `developerRound: true` and the note in `resumeFeedback`.
- [ ] #2 Test: the log tail is capped (line count and bytes) and ANSI-stripped; a job whose log cannot be fetched produces a note that says so and still re-enters.
- [ ] #3 Test: the fourth consecutive CI round on the same PR, or a round whose head equals the previous round's head, routes to the planner with `ci-rounds@<n>` as the reason; `maxCiRounds` is read from `.ai-sdlc/pr-lifecycle.yaml`.
- [ ] #4 Test: a docs-kind PR and a PR whose failure is not a check failure (DIRTY, BEHIND, review) keep today's actions unchanged.
- [ ] #5 `docs/operations/cli-hierarchy.md` states in one paragraph the automatic CI round, its bound and when the planner is reached; the status line shows `ci-round n/3` on such a PR.

## Notes

Evidence: `.ai-sdlc/dispatch/landing/2413/reentered.json` (11 rounds, 05:37Z to 00:52Z), `.ai-sdlc/dispatch/landing/2496/reentered.json` (rounds 20 to 33 minutes apart, each a planner wake), `.ai-sdlc/dispatch/notes/515-1-round4..7.txt` (planner-written notes that are log excerpts). Companion: AISDLC-1230 (reap race), DEC-0396 (re-entering PRs and the open-PR cap).
