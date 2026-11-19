---
id: AISDLC-1335
title: 'A reviewer that leaves out the nonce marker is run again alone instead of aborting the run'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - pipeline-cli
  - adopter
dependencies:
  - AISDLC-1333
references:
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/next-step/review-finalize.test.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/next-step.test.ts
  - pipeline-cli/src/next-step/types.ts
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/next-step/review-prepare.test.ts
  - pipeline-cli/src/incremental-review/review-rounds.ts
  - pipeline-cli/src/incremental-review/review-rounds.test.ts
  - ai-sdlc-plugin/commands/execute.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the review finalize step, the review round number and the execute command text, with tests.'
---

## Description

**Gap.** When one reviewer returns a valid verdict but leaves the nonce marker out of its final message, persisting its transcript is refused (exit 4) and the whole run aborts. Nothing re-runs that one reviewer. The aborted run can only start fresh, which repeats the developer and review rounds. Separately, the round number in the progress line and in the instruction can differ by one.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): `Step 7b.5: persist-reviewer-artifacts failed for test-reviewer: harness transcript .../subagents/agent-<id>.jsonl does not contain the nonce marker; refusing to persist`. The reviewer approved and returned valid JSON, but the marker was missing on that round (it was echoed on the previous run). The same run printed `review-round 2 ... reason=review-uncorroborated` while the instruction said `"round": 1` and reused the `review-r1-*` prompt files.

**Cause (read from the source).**

- `ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh:178-182` greps the harness transcript for the marker and exits 4 before copying anything. The marker proves the reviewer saw this round's prompt and diff. This is correct and stays.
- `pipeline-cli/src/next-step/review-finalize.ts:358-382` runs the script with `allowFailure`, and on any non-zero code returns `{ ok: false, reason }` with no `recoverable` flag, for exit 4 as for every other code.
- `pipeline-cli/src/next-step/next-step.ts:697-701` turns a non-recoverable result into `this.fail(state, 'aborted', ...)`. Only a `recoverable` result reaches `fixReport` (`next-step.ts:135`, `MAX_REPORT_RETRIES = 2`), and that path asks for a corrected report, not for a re-run of one reviewer.
- Reviewers earlier in the same loop are already persisted when a later one fails (`review-finalize.ts:358` onward), so a partial round is left on disk.
- The two round numbers come from different counters. The instruction and the prompt file name use `state.reviewRound`, incremented per run (`next-step.ts:655`, `review-prepare.ts:449`, `next-step.ts:381`). The progress line uses `plan.round`, which is the last recorded round on disk plus one (`pipeline-cli/src/incremental-review/review-rounds.ts:365-366`, printed by `formatRoundLogLine` at `review-rounds.ts:675-679`). After an earlier run left a recorded round, the two differ. `recordDeveloperResponseOf` (`next-step.ts:187-199`) keys the reply by the in-run number while the plan reads it back by the disk number.
- `main` has not changed this since 0.42.0: the script is identical to the 0.42.0 copy, and the last commit touching it or `review-finalize.ts` is AISDLC-701.

**Shape.** Exit 4 for a reviewer is not fatal. The run asks for that one reviewer again, with the same prompt file and the same nonce, up to a fixed small number of times per reviewer per round. The new report replaces the old one, and persistence is tried again with the same marker check. A transcript without the marker is never persisted. When the limit is reached the run aborts with the reason, as today. Other exit codes keep aborting. The round number in the progress line, the instruction, the prompt file names and the stored developer reply is one number for one round.

**Control.** No control changes. The marker check is not loosened: the retry only runs the reviewer again, and the script still refuses any transcript that lacks the marker.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the marker must stay (it binds the transcript to the diff); the requirement that one forgetful reviewer ends the run has no decision behind it. 2. Deleted: the second round counter as a separate source of truth. 3. Simplified or optimised: re-spawn only the reviewer that failed, reusing its prompt file and the round nonce, instead of a fresh run. 4. Accelerated: a missing marker costs one reviewer call instead of the developer and every review round. 5. Automated: a test fails if a missing marker is ever accepted, and one fails if the two round numbers can differ.

- **Retry on exit 4 only.** `finalizeReview` reports a marker refusal as a retry request that names the reviewer. `next-step.ts` answers with a `spawn-reviewers` instruction that holds only that reviewer, keeps the reports of the others, and counts attempts per reviewer in the saved state.
- **Bounded.** One named constant caps the re-runs at 2 per reviewer per round. At the cap, the run aborts with the original reason plus the attempt count.
- **One round number.** The progress line, the instruction, the prompt file names and the developer-reply key all read the round recorded on disk plus one (the value the progress line uses today), so a run that follows an earlier run continues its numbering.
- **Docs.** `execute.md` describes the single-reviewer `spawn-reviewers` instruction.

Out of scope: any change to `persist-reviewer-artifacts.sh` or its marker check; the staged review path in `staged-round.ts`; retries for other exit codes; changing what the marker contains.

## Acceptance Criteria

- [ ] #1 A test in `review-finalize.test.ts` makes the persist runner return exit 4 for one reviewer: the result asks for a re-run of that reviewer and does not abort, and no transcript or verdict for it is written.
- [ ] #2 A test in `next-step.test.ts` drives the exit 4 case: the next instruction is `spawn-reviewers` with exactly that reviewer, the same prompt file and the same nonce; the other reviewers are not spawned again.
- [ ] #3 A test: the re-run reviewer returns the marker, the round completes and the verdict matches a round with no retry.
- [ ] #4 A test: a re-run reviewer that again lacks the marker is refused again; after the attempt cap the run aborts with a reason naming the reviewer and the attempt count, and nothing is persisted for it.
- [ ] #5 A test: persist exit codes 1, 2 and 3 still abort at once with no retry.
- [ ] #6 A test with a recorded round on disk from an earlier run: the progress line round, the instruction `round`, the `review-r<n>-*` file names and the stored developer reply round are the same number.
- [ ] #7 `ai-sdlc-plugin/commands/execute.md` describes the single-reviewer `spawn-reviewers` instruction.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
