---
id: AISDLC-356
title: 'fix(orchestrator): auto-rearm auto-merge after force-push + canonical branch-slug doc/guard'
status: Done
assignee: []
created_date: '2026-05-17'
labels:
  - orchestrator
  - pipeline-friction
  - operator-ergonomics
dependencies: []
priority: high
references:
  - pipeline-cli/src/cli/resume-from-draft.ts
  - pipeline-cli/src/steps/02-compute-branch.ts
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/agents/rebase-resolver.md
---

## Two pipeline-UX bugs

## Bug 1 — Force-push clears `autoMergeRequest`; operator must manually re-arm

**Symptom**: every time the operator force-pushes (rebase, re-sign attestation after stale-envelope cleanup, AISDLC-351 parser fix re-run), GitHub silently clears the `autoMergeRequest` state on the PR. Operator must remember to run `gh pr merge <num> --auto` again.

**Repro**: hit on AISDLC-498, AISDLC-282, AISDLC-322 — every PR that needed a re-sign after rebase.

**Fix**: in `runResumeFromDraft` AND `ai-sdlc:rebase-resolver` subagent, after a successful `git push --force-with-lease`, auto-arm `gh pr merge <num> --auto` again. Idempotent: if it's already armed, GitHub returns "already queued" — no-op.

## Bug 2 — Branch slug mismatch when manually creating worktree

**Symptom**: `git worktree add -b <slug>` with operator-picked slug ≠ orchestrator's canonical slug. The orchestrator's slug formula (`pipeline-cli/src/steps/02-compute-branch.ts`):
- Lowercase title
- Replace non-alphanumeric runs with `-`
- Trim leading/trailing `-`
- Truncate to 50 chars
- Prefix with `ai-sdlc/<task-id-lower>-`

For task title "feat: RFC-0016 Phase 4 — Stage B LLM tie-breaker + Q5 ensemble", the canonical slug is `ai-sdlc/aisdlc-282-feat-rfc-0016-phase-4-stage-b-llm-tie-breaker-q5-e` (truncated mid-word). My manual `git worktree add -b ai-sdlc/aisdlc-282-feat-rfc-0016-phase-4-stage-b-llm-tiebreaker` (sans `q5-e` and with concatenated "tiebreaker") didn't match. `--resume-from-draft` looked up the canonical branch on remote, didn't find it (because my manual one was named differently), failed with `no-draft-pr`.

This bit me during 282 finalization — caused duplicate PRs #513 / #514. Operator had to grant a one-time exception to `gh pr close #513`.

**Fix**:
- (a) Document the canonical slug formula prominently in `ai-sdlc-plugin/commands/execute.md` + a `cli-deps print-canonical-branch <task-id>` helper for ad-hoc operators
- (b) In `runResumeFromDraft`, fall back to `gh pr list --search "AISDLC-<id> in:title"` when the canonical-branch lookup fails — find the PR by task ID in title, not branch name
- (c) In the `ai-sdlc:rebase-resolver` agent, refuse to operate on branches that don't match the canonical slug + emit a clear message pointing at the helper

Pick (a)+(b) for backwards compatibility; (c) for new-PR strictness.

## Acceptance criteria

- [ ] **Bug 1**: post-force-push auto-rearm in `runResumeFromDraft` + `rebase-resolver`. Test: simulate a force-push then verify the spawned `gh pr merge --auto` call is made.
- [ ] **Bug 2a**: canonical-slug helper `cli-deps print-canonical-branch <task-id>` ships. Test: known task title → expected slug.
- [ ] **Bug 2b**: `runResumeFromDraft` falls back to title-search when branch-lookup fails. Test: PR exists with task ID in title but non-canonical branch name; assert resume finds it.

## Source

Operator session 2026-05-17. Bug 1 was a chronic friction across the AISDLC-498/282/322 finalization push cycles. Bug 2 caused the #513/#514 duplicate-PR incident.
