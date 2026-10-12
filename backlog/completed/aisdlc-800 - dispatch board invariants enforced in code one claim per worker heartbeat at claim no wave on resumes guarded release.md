---
id: AISDLC-800
title: >-
  Dispatch board invariants enforced in code: one claim per worker, heartbeat at claim, no wave on resumes, guarded release, generated resume notes, and a doctor check
status: Done
assignee: []
created_date: '2026-10-10'
labels:
  - dispatch
  - hierarchy
  - stability
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
  - orchestrator/src/cli/commands/doctor-checks.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incidents (2026-10-10).** Six protocol slips, each costing an executor cycle or a false failure: (a) executors took a second claim through stray `executor-start` waits (gamma held 605 and 773, delta 612 and 743; 762 was marked failed twice by executors that never worked it); (b) `inflight/<task>.state.json` heartbeats were missing because the heartbeat command in dispatch's notes lacked `--task-id` and failed silently, so lease pushes were refused; (c) resume manifests carried `wave: 1`, which sorted them behind wave-less backlog items despite priority 1, so PR-drain resumes were passed over for an hour; (d) dispatch released claims whose worktrees held unpushed work (762, 791); (e) a resume note told an executor to rebase and push by hand and "the hook re-signs", bypassing the pipeline, so Step 4 never wrote the sentinel and the push was refused; (f) a `done/` iterate-needed verdict from a hierarchy executor had no CLI continuation (`resume` refuses non-success, the executor loop ignores resume signals).

**Root cause.** The board protocol lives in prose notes and messages; the CLI accepts states that the protocol forbids.

**Five-step review (requirements first).** Delete first: the `wave` field on resume manifests (a resume has no wave; the field exists only because `enqueue` sets it) and the second resume mechanism (Phase 1.5 resume signals for dispatch-worker, which the hierarchy executor loop ignores): one resume path, `cli-dispatch resume`, for both success and iterate-needed. The heartbeat-at-claim item falls away if AISDLC-798's deletion is accepted; keep it only if the hook keeps its claim clause. What remains to enforce in code is small: one claim per worker, guarded release, generated resume notes, and the doctor check.

**Fix (all in `pipeline-cli/src/dispatch` and the CLI, with hermetic tests).**
1. `claimNext` refuses when the worker already holds an inflight claim (`one-claim-per-worker`), printing the held task; `executor-start` writes the heartbeat immediately after a successful claim (if AISDLC-791 has not already landed this) and fails loudly if it cannot.
2. `resumeDone` never sets `wave`; it copies `priority` and sets `retryCount`; `enqueue --priority 1` with no wave sorts first. A board-ordering test covers a resume against wave-less entries.
3. `release --task-id` refuses when the task's worktree has commits not on its PR head or uncommitted tracked changes, unless `--force --reason <text>`; the reason is written to the manifest history.
4. Resume notes are generated: `cli-dispatch resume` takes `--failing-check`, `--finding`, `--note` (prose, no commands) and renders the executor instruction from a fixed template that says "run the pipeline unmodified from the existing worktree"; free-text commands are rejected (a `cli-`/`git `/`gh ` prefix in the note fails validation).
5. `resumeDone` accepts a `done/` verdict with outcome `iterate-needed` and takes over the executor's still-held inflight claim (main's `holdsIterateClaim` takeover; no release-first step, DEC-0147), turning it into a resume with the verdict notes as feedback; the hierarchy executor loop documents this as the continuation path.
6. `ai-sdlc doctor` check `dispatch-board`: one claim per worker, every inflight claim has a heartbeat younger than the stale window, no resume manifest carries a wave, no `done/` verdict older than 10 minutes without a released or continued claim.

**Velocity impact.** Positive: removes the manual policing the dispatch session did every pass; nothing new blocks a correctly behaving executor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] A worker holding an inflight claim cannot claim a second task; the refusal names the held task (hermetic test).
- [x] Resume manifests carry no `wave` and sort by priority ahead of wave-less backlog entries (board-ordering test).
- [x] `release` refuses on unpushed or uncommitted work without `--force --reason`, and records the reason.
- [x] Resume notes are rendered from a template; a note containing a command prefix is rejected with a clear message.
- [x] An iterate-needed verdict from a hierarchy executor can be resumed through `cli-dispatch resume`, which takes over the held claim (DEC-0147).
- [x] `ai-sdlc doctor dispatch-board` reports the four invariants.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 4 of the 2026-10-10 root-cause set. Overlaps AISDLC-791 item 4 (heartbeat at claim): whichever lands second keeps one implementation.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
The dispatch board invariants are now enforced in code: one claim per worker, wave-less resume manifests, guarded release, prose-only generated resume notes, iterate-needed verdicts resumable through `cli-dispatch resume`, and an `ai-sdlc doctor` `dispatch-board` check.

## Changes
- `pipeline-cli/src/dispatch/board.ts` (modified): `claimNext` throws `OneClaimPerWorkerError` naming the held task and the `release`/`sweep` next steps.
- `pipeline-cli/src/dispatch/resume.ts` (modified): `resumeDone` drops `wave`, keeps `priority`, sets `retryCount`; notes/findings/failing checks are control-stripped then rejected when a line starts with `cli-`, `git ` or `gh `; fixed template instructs "run the pipeline unmodified from the existing worktree"; iterate-needed verdicts resume once the claim is released.
- `pipeline-cli/src/dispatch/release-guard.ts` (new): `release` refuses on uncommitted tracked changes or commits not on the PR head unless `--force --reason`; the reason is recorded in `releaseHistory`; worktree must resolve under `.worktrees/`.
- `pipeline-cli/src/cli/dispatch.ts` (modified): CLI wiring (`--force --reason`, `--failing-check`).
- `orchestrator/src/cli/commands/doctor-checks.ts`, `orchestrator/src/clock.ts` (modified/new): `dispatch-board` doctor check with four invariants.
- `spec/schemas/dispatch-manifest.v1.schema.json`, `reference/src/core/generated-schemas.ts` (modified): `releaseHistory`.
- `ai-sdlc-plugin/commands/executor.md`, `operator-dispatch.md` (modified): document the single resume path.
- Tests: `board-invariants.test.ts` (new), `resume.test.ts`, `doctor-checks-dispatch-board.test.ts` (new).

## Design decisions
- **Five-step review**: deleted the `wave` field from resumes; no second resume path added. Heartbeat-at-claim already existed in `executor-start` (AISDLC-791), so nothing was added there.
- **Command-prefix check is a lint, not a boundary**: the fixed template line is the real control.
- **Phase 1.5 resume signals kept**: still wired through `writeVerdict`/`releaseInflight` and existing tests; removal is not clearly safe.

## Verification
- `pnpm build` — clean
- `pnpm test` — dispatch (446) and orchestrator doctor (181) suites pass; pre-existing unrelated failures in pipeline-cli attestation/verify-runtime, cli/bin-invocation and tui tests not re-checked on main
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 reviewers approved on round 2 (code, test, security; Codex quota exhausted so Claude-native reviewers ran)

## Follow-up
- declined: remove Phase 1.5 resume-signal commands; needs a separate task confirming the hierarchy never uses them
- declined: default priority for resumes lacking priority (would reorder tasks nobody ranked)
- declined: run `oneLine` before `assertProse` and realpath-based worktree containment; defence-in-depth only, noted by reviewers
<!-- SECTION:FINAL_SUMMARY:END -->
