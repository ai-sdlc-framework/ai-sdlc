---
id: AISDLC-1170
title: 'RFC-0061 Phase 1: clean-replay carry-forward rule in one function, replacing patch-id comparison'
status: To Do
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

- [ ] AC-1: Message-only amend carries forward. Test with a real temporary git repo.
- [ ] AC-2: A rebase onto a main that changed unrelated files carries forward.
- [ ] AC-3: A rebase that needed conflict resolution does not carry forward, even when the patch-id is unchanged.
- [ ] AC-4: A rebase with one extra edited line does not carry forward.
- [ ] AC-5: On git older than 2.40 the function refuses with a named error.
- [ ] AC-6: `merge-without-queue.md` states the queue rule and the direct-squash reasoning.
