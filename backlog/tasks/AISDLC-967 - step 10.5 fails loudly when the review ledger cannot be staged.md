---
id: AISDLC-967
title: 'Step 10.5 fails loudly when the review ledger or transcript leaves cannot be staged, instead of shipping without them'
status: To Do
assignee: []
created_date: '2026-10-17'
labels:
  - pipeline
  - trust-chain
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/src/incremental-review/review-rounds.ts
priority: high
dispatchable: true
---

## Description

`ship.ts` commits the pipeline-owned files (transcript leaves and the task's review ledger) before the Step 10.5 rebase with `git add -- <path>` under `allowFailure: true` and a porcelain pre-check. When a path is ignored (a `.gitignore` or `.git/info/exclude` entry, which every worktree inherits from the parent), porcelain shows nothing, `git add` is a silent no-op, and the PR ships without its ledger. For a week in October 2026 this disabled the incremental review on every task (it reads prior findings only from committed ledgers, so every round fell back to a full review) and no signal was raised anywhere.

**Five-step review (requirements first).**
1. Requirement questioned: must the ledger be in the PR at all, or could the review read it from the worktree? The committed copy is the only one that survives the worktree and the only one another session can read; the requirement stands.
2. Delete: the `allowFailure: true` on the ledger add; a refused add is a failure.
3. Simplify: after the add, `git ls-files --error-unmatch <ledger>` must succeed when the ledger file exists on disk; otherwise Step 10.5 returns `failed` with reason `ledger-not-staged` naming the ignore rule (`git check-ignore -v`) so the operator sees the cause in the verdict, not a green PR with a hole.
4. Accelerate: nothing to accelerate; the check is one git call.
5. Automate: a unit test in `ship.test.ts` with an ignored ledger path asserts the failed outcome and the reason string; `ai-sdlc doctor` gains a check that `git check-ignore .ai-sdlc/reviews/x.jsonl` and `.ai-sdlc/transcript-leaves/x.jsonl` are not ignored in the parent, so the misconfiguration is caught at session start, not at ship.

## Acceptance Criteria

- [ ] With `.ai-sdlc/reviews/` ignored, Step 10.5 returns `failed` with a reason that names the ignoring rule; nothing is pushed.
- [ ] With the ledger present and not ignored, behaviour is unchanged (one chore commit, then rebase).
- [ ] `ai-sdlc doctor` flags an ignore rule covering `.ai-sdlc/reviews/` or `.ai-sdlc/transcript-leaves/`.
- [ ] Tests cover both the ignored and the normal path.
