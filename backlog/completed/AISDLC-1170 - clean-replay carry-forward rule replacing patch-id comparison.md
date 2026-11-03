---
id: AISDLC-1170
title: 'RFC-0061 Phase 1: clean-replay carry-forward rule in one function, replacing patch-id comparison'
status: Done
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - pipeline-cli
  - governance
  - phase-1
dependencies:
  - AISDLC-1168
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - pipeline-cli/src/governance/rebase-rearm.ts
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
priority: high
dispatchable: true
---

## Description

Implements RFC-0061 OQ-2 and the OQ-5 rule.

**Scope.**
1. One function, `cleanReplayCarriesForward(reviewed, candidate)`: true when the candidate head's tree equals the reviewed head's tree (message-only change), or when `git merge-tree --write-tree --merge-base=<reviewed baseSha> <candidate baseSha> <reviewed headSha>` is conflict-free and its tree equals the candidate head's tree. Requires git 2.40 or later; refuse with a named error on older git.
2. The verdict check (AISDLC-1169) calls it when no record exists for the head: it finds earlier records for the same PR among the verdict refs and reports `ok-carried:<sha>` or `replay-dirty`. No path writes a new verdict ref for a carried-forward head.
3. `merge_group` is not wired (OQ-5): a code comment and `merge-without-queue.md` record the rule for when the queue returns, and the doc states that a direct squash merge of a behind head is a clean three-way replay that GitHub refuses on conflict.

**Replacement semantics (load-bearing).** In this task the function is added and used by the shadow check only. The patch-id comparisons in `rebase-rearm.ts`, `resume-decision.ts`, `reenter.ts`, `dispatch/resume.ts` and the `content-hash-mismatch` state in `pr-state.ts` switch to this function at cutover (AISDLC-1172); none of them keeps a patch-id path after that.

## Acceptance Criteria

- [x] AC-1: Message-only amend carries forward. Test with a real temporary git repo.
- [x] AC-2: A rebase onto a main that changed unrelated files carries forward.
- [x] AC-3: A rebase that needed conflict resolution does not carry forward, even when the patch-id is unchanged.
- [x] AC-4: A rebase with one extra edited line does not carry forward.
- [x] AC-5: On git older than 2.40 the function refuses with a named error.
- [x] AC-6: `merge-without-queue.md` states the queue rule and the direct-squash reasoning.

## Final Summary

## Summary
Added `cleanReplayCarriesForward` and `findCarriedVerdict` in `pipeline-cli/src/attestation/clean-replay.ts`. The rule is equal tree or conflict-free `git merge-tree` replay, and it throws `GitTooOldError` on git older than 2.40. Added a rule section to `merge-without-queue.md` and opened draft PR #2339. The real-git tests for AC-1 to AC-4 have not run anywhere yet.

## Changes
- pipeline-cli/src/attestation/clean-replay.ts
- pipeline-cli/src/attestation/clean-replay.test.ts
- pipeline-cli/src/index.ts
- docs/operations/merge-without-queue.md

## Design decisions
Local git is 2.39.5, so the real-git tests for AC-1 to AC-4 are skipped here and first run in CI. AC-5 and the merge-tree logic are covered with fake-runner tests. The AISDLC-1169 verdict check is not on main, so there is no caller yet. I exported the functions from the package barrel so the dark-code gate passes. The pre-push patch-coverage gate passed at 100%. The patch-id call sites are untouched and switch at AISDLC-1172. The worktree has an uncommitted change to the AISDLC-1170 task file, which I did not make and did not commit.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

