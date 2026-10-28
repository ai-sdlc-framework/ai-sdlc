---
id: AISDLC-1098
title: 'resume: the pre-sign rebase step stages the attestation file it removes, and the dirty-worktree check ignores unstaged deletions under .ai-sdlc/attestations, so a fix round no longer dies on its own re-sign'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - pipeline
  - orchestrator
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Observed 2026-10-28 16:45Z on two fix rounds in one minute: AISDLC-775 (PR #1989, executor delta) and AISDLC-969 (PR #1852, executor gamma) both failed with `cause: dirty-worktree` at the pre-sign rebase step (step 10.5 of the resume in `pipeline-cli/src/next-step/next-step.ts`). In each case the only dirt was one tracked file under `.ai-sdlc/attestations/` (`c49f40bc….v6.dsse.json`, `d3191cd6….v6.dsse.json`) deleted and unstaged inside the task worktree: the re-sign path removes the stale envelope for the previous content hash, then the rebase step refuses because the tree is dirty. The pipeline blocks itself. Both rounds also report `review-skipped: unchanged` although their resume note demanded a developer pass (that half is AISDLC-1093). A third round, AISDLC-1075 (PR #2027), failed `push-non-fast-forward` because the developer pass force-pushed and step 10.5 then rebased again, so local and remote diverged; the step must push what it rebased.

## Fix

**Five-step review (requirements first).** The requirement questioned is "refuse a rebase on any dirty tree": the reason is that a rebase must not swallow uncommitted work; a deletion the pipeline itself made one step earlier is not the developer's work. Deleted: nothing. Simplified: the re-sign path stages its own removal (`git rm`) so the tree is clean by construction; the dirty check additionally ignores unstaged deletions under `.ai-sdlc/attestations/` as a belt for older worktrees. Accelerated: a fix round that reaches step 10.5 completes instead of failing to the board. Automated: a resume fixture test with a deleted-unstaged attestation file and one with a diverged remote after a developer force-push.

1. `next-step.ts` re-sign path: remove the stale envelope with `git rm --quiet` (staged), never `unlink`.
2. Step 10.5 dirty check: paths under `.ai-sdlc/attestations/` with status ` D` (unstaged deletion) do not count as dirt; any other dirt still refuses with the file list.
3. Step 10.5 push: after the rebase, push with `--force-with-lease=<branch>:<expected-remote-sha>` through the sanctioned lease path from the task worktree, where the expected sha is the remote head read before the rebase; a non-fast-forward then means a real remote change and is reported with both shas.
4. Tests: (a) deleted-unstaged attestation → rebase proceeds; (b) a modified source file → still refused; (c) remote moved by the developer force-push → the lease push succeeds; (d) remote moved by someone else → refusal names both shas.
5. `docs/operations/cli-hierarchy.md`: the resume section states the dirt rule and the lease push.

## Acceptance Criteria

- [ ] A resume in a worktree whose only dirt is a deleted-unstaged file under `.ai-sdlc/attestations/` passes step 10.5.
- [ ] A resume whose developer pass force-pushed the branch lands its rebased head with one lease push, no `push-non-fast-forward` verdict.
- [ ] Any other unstaged change still refuses with the file list.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
