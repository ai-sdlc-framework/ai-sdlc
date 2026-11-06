---
id: AISDLC-1196
title: 'A re-entered review round always ends with a verdict ref'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - pipeline-cli rfc-0061 defect fix
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/verdict-ref-push.ts
  - pipeline-cli/src/incremental-review/review-rounds.ts
  - pipeline-cli/src/next-step/review-prepare.ts
priority: high
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-06 (decision rubric): fix both defects in one task, then re-enter AISDLC-1189.

RFC-0061 makes `refs/ai-sdlc/verdicts/<head>` the merge gate. Two defects mean a re-entered PR can never get that ref. AISDLC-1189 (#2413) has been stuck on them since 11:05Z.

**Defect 1: the lease fallback push drops the ref.** In `next-step/ship.ts` the first push is atomic (branch plus verdict refspec). Step 10.5 rebases onto main on every round to drop earlier attestation chore commits, so a round on a PR that was already pushed rewrites the branch. The atomic push is then refused as non-fast-forward, and the divergence path calls `leasePushOwnRebaseShip`, which pushes `HEAD:refs/heads/<branch>` only. The branch lands with no verdict ref and CI verdict-check fails `no-record`. Seen on #2308 (AISDLC-1156) three times on 2026-11-06 (heads 4bc1e79d, 52d34e3b, 9a2fada7, the third with main unchanged) and on #2415 (AISDLC-1183, ba85fec0).

**Defect 2: the unchanged-content skip ignores missing reviewers.** `incremental-review/review-rounds.ts` returns `mode: 'skip'` when content is unchanged and the anchor round was approved. Corroboration checks only the roles recorded in the anchor (`anchor.reviewers`), not the required reviewer set. `next-step/review-prepare.ts` hard-codes `allowSkip: true`, so nothing overrides it. On #2413 at 787253b9 the anchor held only correctness-reviewer, the round ran "round 5 mode=skip", security-reviewer never ran, and no verdict record was written.

## Fix

**Five-step review (requirements first).** Requirement: a review round on a PR ends with a verdict ref for the pushed head, or with a stated reason why not (AISDLC-1193). Delete: nothing; both the lease fallback and the skip are needed. Simplify: (1) pass the refspec already built for the attempt into `leasePushOwnRebaseShip` and push `--atomic --force-with-lease=refs/heads/<b>:<recorded> origin HEAD:refs/heads/<b> <refspec>`, rebuilt for the current head; (2) allow `skip` only when the anchor's approved roles cover every role the verdict record will require (the same required set `review-finalize.ts` uses for coverage) AND a verdict ref already exists for the head; otherwise plan `full` with a reason such as `unchanged-coverage-short`. Accelerate/automate: one end-to-end ship test.

## Acceptance Criteria
- [x] #1 The lease fallback push includes the verdict refspec atomically when the round has an approved verdict draft.
- [x] #2 When no refspec can be built on the lease path, the done output carries a note saying the verdict ref was not pushed (no silent skip).
- [x] #3 An unchanged-content round whose anchor lacks any required reviewer plans `full`, not `skip`, and names the reason.
- [x] #4 An unchanged-content round with full coverage but no verdict ref for the head plans `full`.
- [x] #5 A test re-enters an approved PR after main moves and asserts the lease push carries the verdict refspec; a test with an anchor missing security-reviewer asserts a full plan.

## Final Summary

## Summary
The lease fallback push now carries the verdict refspec in one atomic push, and says so in the done notes when no refspec can be built. An unchanged-content skip now plans `full` when the anchor lacks a required reviewer (reason `reviewer-missing`) or the head has no remote verdict ref (reason `no-verdict-ref`).

## Changes
- pipeline-cli/src/next-step/ship.ts
- pipeline-cli/src/incremental-review/incremental.ts
- pipeline-cli/src/incremental-review/review-rounds.ts
- pipeline-cli/src/steps/07-build-review-prompts.ts
- pipeline-cli/src/next-step/ship.test.ts
- pipeline-cli/src/next-step/review-prepare.test.ts
- pipeline-cli/src/next-step/staged-round.test.ts

## Design decisions
The skip guard (guardSkipPlan) runs in buildReviewPrompts after reviewer selection, because the required set is only known then. The head-has-verdict-ref check uses `git ls-remote`, so an offline or failed lookup counts as no ref and plans a full round. Two existing skip tests (review-prepare, staged-round) were updated to supply `skipRoles` and a verdict ref. The pre-push patch-coverage gate passed at 44/44 lines. I did not capture the combined `pnpm build && pnpm test && pnpm lint && pnpm format:check` run as a single result, because the first background run's exit code was masked by a pipe. I re-ran the checks separately instead. Lint and `format:check` passed. The full pipeline-cli vitest run passed (577 files, 12368 tests), and `tsc --noEmit` was clean. The PR is a draft.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (244 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

