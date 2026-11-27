---
id: AISDLC-1386
title: 'A hold label keeps a single PR from being armed or merged'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - feature
  - pipeline-cli
  - governance
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/cli/hierarchy.ts
priority: high
---

## Description

**Gap.** Nothing holds one trusted PR open for a human. `cli-merge-if-eligible` reads no labels (PR read at `merge-if-eligible.ts:422`), governance-sensitive paths are audited, not refused (DEC-0072, `merge-if-eligible.ts:551-614`), and the reconciler's PR list (`reconcile.ts:1668`) does not request labels. Converting to draft does not hold either (AISDLC-1385). `cli-hierarchy hold` pauses the whole board, not one PR.

**Failure.** arcana-website #184 (ARC-130) adds `.github/workflows/domain-warden.yml` and was meant to stay open for review. Once its author is in `mergeAuthors`, the gate merges it on green.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a reviewer needs a per-PR stop that survives ticks and is visible on GitHub; the board-wide hold is too broad. 2. Deleted: nothing. 3. Simplified: one label, `ai-sdlc/hold` (the Prow `do-not-merge/hold` precedent), read in the two places that arm or merge; no new state file. 4. Accelerated: labels come in the PR list call the reconciler already makes. 5. Automated: tests below. Adding a stop tightens a control, so this is class (a).

- `cli-merge-if-eligible` refuses (merge and `--arm`) a PR carrying `ai-sdlc/hold`, with the reason `PR is held (label ai-sdlc/hold)`; it also disarms auto-merge if armed.
- The reconciler requests `labels` and takes no arm, flip or merge action on a held PR; it shows it as held on the board.
- `cli-hierarchy pr-hold <pr> --reason <text>` and `pr-hold <pr> --clear` add or remove the label and post the reason as a PR comment. Planner or operator only, like `hold`.
- Adopter scaffold documents the label; `cli-merge-if-eligible` creates nothing on GitHub by itself.

## Acceptance Criteria

- [x] #1 A test: `cli-merge-if-eligible` refuses a labelled PR for merge and for `--arm`, and disarms an armed one.
- [x] #2 A test: the reconciler takes no arm, flip or merge action on a labelled PR.
- [x] #3 A test: `pr-hold` adds and clears the label and refuses an executor caller.
- [x] #4 `docs/operations/cli-hierarchy.md` documents the label and command.
- [x] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
