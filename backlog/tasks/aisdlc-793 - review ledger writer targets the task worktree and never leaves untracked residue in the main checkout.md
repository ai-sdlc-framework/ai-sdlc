---
id: AISDLC-793
title: >-
  Review ledger writer resolves the task worktree and refuses to write into the main checkout, so reviews never leave untracked .ai-sdlc/reviews residue on main
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - attestation
  - hygiene
  - doctor
  - operator-request
dependencies: []
references:
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/src/cli/attestation.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - ai-sdlc-plugin/commands/execute.md
  - docs/operations/transcript-management.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dominique (operator) asked for this after a cleanup on 2026-10-10: eleven untracked review ledgers (`aisdlc-543`, `546`, `562`, `663.5`, `700`, `702`, `708`, `716`, `720.1`, `721`, `730`) had accumulated under `.ai-sdlc/reviews/` in the main checkout. They were committed by hand in chore PR #1326, and the untracked copies then had to be deleted from the parent because they block a fast-forward pull. This is recurring residue, not a one-off.

Root cause: `appendReviewLedgerRecord(record, repoRoot?)` in `pipeline-cli/src/attestation/reviews-ledger.ts` appends to `<repoRoot>/.ai-sdlc/reviews/<task-id-lower>.jsonl`, and `cli-attestation emit-leaf` (`pipeline-cli/src/cli/attestation.ts`) resolves `repoRoot` as `--repo-root`, else `REPO_ROOT`, else `process.cwd()`. The `/ai-sdlc execute` Step 7c call passes `--repo-root "$WORKTREE_PATH"`, but every other caller (reconcile ticks, ad-hoc reviewer flows, sessions rooted in the parent folder, `emit-leaf` run by hand) falls through to the cwd, which in Pattern C is the read-only main checkout. The ledger then lands outside the task's PR, is never committed, and sits in the parent as untracked debris.

Fix the writer, not the callers. When the resolved repo root is a Pattern C parent (`<root>/.worktrees/` exists and is non-empty) and the target `.ai-sdlc/reviews/` path is inside that parent, `appendReviewLedgerRecord` (or a resolver it calls) must route the write to the task's worktree: `<parent>/.worktrees/<task-id-lower>/` when it exists, otherwise the worktree whose `.active-task` sentinel names this task id (same rule the plugin MCP server uses, see CLAUDE.md "Pattern C routing"). When no worktree can be resolved for the task, refuse with a clear error naming the task id, the attempted path and the `--repo-root` flag, rather than writing into the main checkout. A non-Pattern-C repo (no `.worktrees/`) keeps today's behaviour unchanged.

Add an `ai-sdlc doctor` check (`orchestrator/src/cli/commands/doctor-checks.ts`) named `untracked-review-ledgers` that lists untracked `.ai-sdlc/reviews/*.jsonl` files in the main checkout. It warns with the file list and the task ids they belong to; `--fix` is out of scope (the fix is a decision per file: commit in a chore PR or delete), so the check only points at the runbook line added by this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `appendReviewLedgerRecord` never creates or appends a file under `<parent>/.ai-sdlc/reviews/` when `<parent>/.worktrees/` exists and is non-empty; it writes to the resolved task worktree, or throws an error that names the task id, the attempted path and `--repo-root`.
- [ ] Resolution order is `<parent>/.worktrees/<task-id-lower>/` first, then a worktree whose `.active-task` sentinel matches the task id; the resolver is exported and unit-tested in `reviews-ledger.test.ts` with a temp directory that models a Pattern C parent (worktree present, sentinel-only, and neither).
- [ ] Behaviour in a repo without `.worktrees/` is unchanged, covered by an existing or new test.
- [ ] `cli-attestation emit-leaf` run from the main checkout without `--repo-root` for a task that has a worktree appends to that worktree's ledger; a hermetic CLI test asserts the parent's `.ai-sdlc/reviews/` stays empty.
- [ ] `ai-sdlc doctor` gains the `untracked-review-ledgers` check with a test in `doctor-checks.test.ts` covering zero and several untracked ledgers; `--fix` leaves them alone and says so.
- [ ] `docs/operations/transcript-management.md` reviews-ledger section documents the routing rule, the refusal, and what to do with ledgers the doctor check reports.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Requested by Dominique on 2026-10-10 after the stray-ledger cleanup (chore PR #1326). Related: AISDLC-616 introduced the ledger; AISDLC-216 defines Pattern C routing for the MCP server; the "parent-folder session limits" note already records that sessions rooted in the parent need an explicit project dir for `emit-leaf`.
