---
id: AISDLC-1385
title: 'The reconciler never marks ready a PR that someone converted back to draft'
status: In Progress
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - governance
dependencies: []
references:
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
priority: high
---

## Description

**Gap.** `pipeline-cli/src/hierarchy/pr-state.ts:223` classifies `green && f.draft && f.approvedVerdict` as `ready-to-flip`, and `pipeline-cli/src/hierarchy/reconcile.ts:498-500` (`flip-ready-takeover`) runs `gh pr ready`; the next pass arms auto-merge. `approvedVerdict` (`reconcile.ts:1732-1753`) only means a success verdict exists and no inflight manifest does. The reconciler reads draft state as the boolean `isDraft` (`reconcile.ts:1668`, `:1790`) and fetches no timeline, so it cannot tell a PR dispatch opened as draft from one a human or the planner converted back to draft to stop it.

**Failure.** arcana-website #205 (ARC-80 legal pages): the planner converted the PR to draft on an operator ruling because unfinished legal text would go live. The reconciler flipped it ready and merged it as 3908a24; it had to be reverted (#206). Converting to draft is the only stop GitHub offers a reviewer, and the reconciler overrides it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the flip exists to finish PRs dispatch itself opened as draft whose executor died after an approved verdict; it was never meant to override a person. 2. Deleted: the assumption that every green draft with an approved verdict is dispatch's own draft. 3. Simplified: dispatch opens drafts at creation, which produces no convert-to-draft event, so any `ConvertToDraftEvent` on the PR means someone put it back, whoever they are. 4. Accelerated: the timeline is read only for `ready-to-flip` candidates, not every PR. 5. Automated: tests below.

- Before acting on `flip-ready-takeover`, read the PR timeline for `CONVERT_TO_DRAFT_EVENT` (GraphQL `timelineItems(itemTypes: [CONVERT_TO_DRAFT_EVENT])`). If any exists, do not flip: route the PR to the planner once per head sha with the reason `converted back to draft by <actor> at <time>; not flipping`.
- A failed timeline read refuses the flip (fail closed) and routes with that reason.
- No change to how dispatch opens PRs.

## Acceptance Criteria

- [ ] #1 A test: a green draft PR with an approved verdict and a convert-to-draft event is not flipped and is routed to the planner with the actor in the reason.
- [ ] #2 A test: the same PR with no convert-to-draft event is still flipped (existing behaviour).
- [ ] #3 A test: a failed timeline read does not flip.
- [ ] #4 The routing is sent once per head sha, not every tick.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
