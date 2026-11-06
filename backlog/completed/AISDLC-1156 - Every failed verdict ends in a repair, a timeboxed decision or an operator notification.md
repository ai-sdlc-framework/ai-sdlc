---
id: AISDLC-1156
title: 'Every failed verdict ends in a repair, a timeboxed decision or an operator notification: the dispatch playbook finishes a repaired push (verify, mark ready, delivered verdict), a stuck signed PR opens a stall that escalates and notifies, and route-to-planner stops being a terminal state'
status: Done
assignee: []
created_date: '2026-11-02'
labels:
  - hierarchy
  - dispatch
  - governance
dependencies:
  - AISDLC-1154
references:
  - pipeline-cli/src/hierarchy/playbook.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/drain-stall.ts
  - pipeline-cli/src/hierarchy/stall-notice.ts
  - pipeline-cli/src/hierarchy/human-attention.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/status.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Description

On 2026-11-01 (AISDLC-1136, #2246) and 2026-11-02 (AISDLC-1153, #2282) a task re-entry passed verify, review and signing, failed only its final push, and then sat as an unowned draft for hours until the operator noticed and prompted the planner. Operator ruling 2026-11-02 ~16:00Z: a pipeline that depends on a human noticing a failure is a workflow failure. Decision DEC-0291 records the invariant this task implements.

What the code does today, by reading (`pipeline-cli/src/hierarchy/`):

- `playbook.ts` classifies `push-non-fast-forward` as mechanical (`MECHANICAL_SHAPES`, `rebase-push`) and can lease-push from the worktree, but on success it only records `OperatorPlaybookAction done` (around line 488). It never re-queues the task, verifies the attestation, marks the PR ready or writes a delivered verdict; `requeue` is limited to `REQUEUEABLE_CAUSES`. The repaired PR is then "unowned: draft task PR with no live manifest" in `reconcile.ts` (around line 1204) because `reclaimable` needs a failed verdict carrying `signedAt`, which the push-failure verdict lacks.
- `route-to-planner` runs no command (`reconcile.ts` `actionCommands` default null, around line 408), is exempt from the same-head guard and from aging (around lines 245 and 645), and is reported once per `pr|headSha|state` key through one `session.send` to the planner (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts` around line 356). For #2282 no routing record was written at all (`landing/planner-routes.json` has no `2282` key), so nothing was ever sent.
- `drain-stall.ts` opens a stall only for eligible queued work with an idle executor; `human-attention.ts` only for a `[needs-human-attention]` title or a spent review budget after 24 h; `stall-notice.ts` (desktop notification) is a CLI subcommand nothing calls. A stuck PR after a failed verdict matches none of them.

**Five-step review (requirements first).**
1. Requirement questioned: should a mechanical repair ever route to a model session? No. A deterministic repair is a command. The planner receives class (b) and (c) questions only (RFC-0051 §8); a stale lease on a fast-forward push is neither.
2. Delete: `route-to-planner` as a terminal state for mechanical failure shapes, and its exemption from aging. The pane line "aged PR" as the only signal.
3. Simplify: one invariant, checked by the tick: every failed verdict ends in exactly one of (i) repaired and re-queued or delivered, (ii) a Decision Catalog entry with a timebox and an autonomous fallback, (iii) an operator notification with a deadline. A verdict in any other state past `stuckAfterMinutes` (default 60) is itself a stall.
4. Accelerate: close the playbook loop so a signed, reviewed head never waits on a model: after a successful repair push, verify the attestation at the pushed head, mark the PR ready, write a `delivered` verdict (with `signedAt` from the envelope) and hand the PR to the landing lane in the same tick.
5. Automate: extend the stall detector with a stuck-PR signature (failed verdict with a review or signature and no delivered PR within `stuckAfterMinutes`): open a stall record, file `cli-decisions escalate` once with a timebox, and fire the existing stall-notice channel. Status output lists it under a `stuck` heading, and `cli-hierarchy status` exits non-zero when any PR violates the invariant for more than the threshold.

Velocity impact: a successful repair lands without a human; the two incidents each cost roughly ten hours of idle drain. The nine tasks behind 1153 were all waiting on that one PR.

## Acceptance Criteria

- [x] AC-1: In `playbook.ts`, after a successful `rebase-push` (or any repair that pushes), the step verifies the attestation at the pushed head, runs the shared mark-ready path (AISDLC-1149 detection), writes a `delivered` verdict carrying `signedAt` and `prNumber`, and moves the task to the landing lane; the failed verdict is kept as history, not as the live state. Tests cover success and each refusal (verify fails, mark-ready refused) with a scripted runner.
- [x] AC-2: `reconcile.ts`: `route-to-planner` is no longer exempt from aging; a routing with no state change for `stuckAfterMinutes` (config, default 60) re-escalates once per threshold window as a stall, not as a repeated message. A routing record is written on every first route (the #2282 case where none was written is covered by a regression test).
- [x] AC-3: `drain-stall.ts` gains the stuck-PR signature: a failed verdict with `signedAt` or a review record and no delivered PR for `stuckAfterMinutes` opens a stall of kind `stuck-pr` with the PR number, head sha and cause; closing happens when the PR is delivered or landed. The hooks module sends the stall to the planner as today AND calls the stall-notice channel (`stall-notice.ts`) once per open stall.
- [x] AC-4: On opening a `stuck-pr` stall the tick files one `cli-decisions escalate` with `--route operational`, a timebox from config (default 4 h) and the repair command as the autonomous fallback; a second open on the same PR and head is a no-op. Covered by a test on the tick with a recording decision client.
- [x] AC-5: `status.ts` prints a `stuck` section (PR, cause, age, which of the three terminal states is missing) and `cli-hierarchy status --check` exits 1 when any entry is older than the threshold; `docs/operations/cli-hierarchy.md` documents the invariant, the config key and the exit code.
- [x] AC-6: The RFC-0051 §8 amendment paragraph (filed by the planner under DEC-0291 in a docs-lane PR) is referenced from the code comment at the invariant check, and the regression tests name the two incidents (#2246, #2282).

## Notes

Origin: operator ruling 2026-11-02 ~16:00Z ("the whole pipeline is dependent on a human to notice a failure... how can we stop this from happening in the future?"), planner trace of `playbook.ts`, `reconcile.ts`, `drain-stall.ts`, `human-attention.ts`, `stall-notice.ts` and the hooks module. Decision: DEC-0291. Depends on AISDLC-1154 (fast-forward fallback in Step 11) so the first repair shape needs no playbook push at all; the playbook path stays for the real-rebase shapes. Related: AISDLC-1155 (verify failures named), AISDLC-1149 (shared mark-ready detection), AISDLC-1150 (dispatch restart ordering).

## Final Summary

## Summary
Fixed the round-1 review finding: `formatStatus` in `status.ts` spread the stuck lines twice, so a stuck PR printed the `stuck:` block twice. The duplicate spread is removed. I added an assertion in `stuck-pr.test.ts` that the PR #2282 line appears exactly once.

## Changes
- pipeline-cli/src/hierarchy/status.ts
- pipeline-cli/src/hierarchy/stuck-pr.test.ts

## Design decisions
I rebased onto origin/main (already up to date). The lease push of the fix commit went through, and the pre-push hooks passed. PR #2308 was already open as a draft. The first push attempts were blocked by the governance hook because of the `cd &&` prefix, so I pushed with `git -C <worktree> push --force-with-lease`.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

