---
id: AISDLC-1249
title: 'cli-decisions add --file and answer --file push to distinct branches, so an answer never collides with the merged add branch left on origin'
status: Done
assignee: []
created_date: '2026-11-08'
labels:
  - decisions
  - filing
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/src/cli/file.ts
  - docs/operations/decision-authority.md
priority: medium
dispatchable: true
dispatchableReason: 'Planner wake 2026-11-08 18:0xZ (DEC-0401 keep-and-automate): cli-decisions answer DEC-0401 --file --pr pushed its event commit to ai-sdlc/file-dec-0401, the branch the add step had used for #2583 and that origin still held after the merge; the push was rejected as non-fast-forward and gh pr create failed with an empty message, so the planner opened #2586 by hand from the pushed commit. The same name is reused by every later event of a decision.'
---

## Description

**Gap.** `cli-decisions ... --file` files through `cli-file` on branch `ai-sdlc/file-<dec>` (help text, AISDLC-1161) for every event type of a decision: `add` and `answer` push to the same name. GitHub does not delete the branch when the add PR merges, so the answer's push is rejected as non-fast-forward against a branch whose tip is already on main, and the error is reported as `gh pr create failed:` with no message. Nine such `ai-sdlc/file-*` leftovers sit on origin today (`file-790`, `file-dec-0111`, `file-dec-0224`, `file-dec-0401` among them).

**Shape.** The branch carries the event type and a short time stamp: `ai-sdlc/file-<dec>-<type>-<hhmm>`; the `--update` and `--close` filings of `cli-file task` already use their own prefixes. The error path reports the git push stderr, not the later `gh pr create` step. No remote branch deletion is added (branch cleanup stays with the repository setting and `/ai-sdlc cleanup`).

## Fix

**Five-step review (requirements first).**
1. Question: should the CLI instead delete the merged branch? No; agents never delete branches, and a unique name removes the collision without a destructive step.
2. Delete: the shared single branch name per decision.
3. Simplify: one branch-name helper in `cli/file.ts` used by both callers.
4. Accelerate: none.
5. Automate: a test that two consecutive `--file` events of one decision produce different branch names, and a test that a rejected push surfaces its stderr.

## Acceptance Criteria

- [x] AC-1: `cli-decisions add --file` and a following `answer --file` on the same decision push to different branches; test.
- [x] AC-2: a rejected `git push` reports the push stderr as the error and does not run `gh pr create`; test.
- [x] AC-3: `docs/operations/decision-authority.md` filing paragraph names the branch pattern.
- [x] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Decision `--file` filings now push to `ai-sdlc/file-<dec>-<type>-<hhmm>` (for example `-add-` and `-answer-`, UTC time), so an answer no longer collides with the merged add branch left on origin. `fileRebase` falls back to the single matching suffixed remote branch. The `decisions.ts` help text and the `decision-authority.md` filing paragraph name the new pattern.

## Changes
- pipeline-cli/src/cli/file.ts
- pipeline-cli/src/cli/file.test.ts
- pipeline-cli/src/cli/decisions.ts
- pipeline-cli/src/cli/decisions-file-flag.test.ts
- docs/operations/decision-authority.md
- backlog/tasks/AISDLC-1249 - cli-decisions answer file uses its own branch name.md

## Design decisions
The push-error path needed no code change. The existing `git()` helper already throws `git push ... failed: <stderr>` before `gh pr create` runs, so AC-2 is covered by a new test that locks that behaviour in. If an add and an answer for the same decision are filed in the same minute with the same type, the branch names still match and the push is rejected, now with the git stderr in the error. The PR was opened as a draft.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

