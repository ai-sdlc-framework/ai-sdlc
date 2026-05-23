---
id: AISDLC-400
title: 'feat(ci): drop GH merge queue, replace with branch-protection rules + repo settings for parallel direct-merge'
status: Done
labels: [ci, merge-queue, throughput, operator-merge, architecture]
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/ai-sdlc-gate.yml
  - CLAUDE.md
  - docs/operations/quality-gate.md
priority: critical
permittedExternalPaths: []
---

## Description

Operator architectural review (2026-05-23) determined the GH merge queue is overkill for this repo's scale (1-5 PRs in flight, solo operator + agents, mostly disjoint files). Queue benefits — serialized merges, pre-merge skew testing, atomic transactions — solve problems we don't have (concurrent human merges, multi-team skew). Queue costs — 1x throughput, 10-15 min update-branch CI re-run per PR, v4-kick (eliminated by AISDLC-398), merge_group event complexity — are felt acutely.

This task drops the queue and replaces with equivalent safety via:
- Branch protection rules: require `ai-sdlc/pr-ready` + `Backlog Drift` status checks
- Repo settings: default merge method = squash, disallow merge commits + rebase merges
- `auto-enable-auto-merge.yml`: change to `gh pr merge --squash --auto` (no queue)
- Workflow cleanup: remove `merge_group` event hooks (they become unnecessary)

Net: parallel merges, ~30s wait per merge, no v4-kick, no update-branch CI re-run cost.

## Acceptance criteria

- [ ] AC-1: `.github/workflows/auto-enable-auto-merge.yml` updated to use `gh pr merge --squash --auto` (or appropriate flag for direct merge). Comment in workflow notes the queue was dropped per AISDLC-400.
- [ ] AC-2: All workflows hooking `merge_group` events updated: either remove the `merge_group` trigger (workflow no longer fires on queue events, since there is no queue) OR add a guard that short-circuits when no merge queue is configured. Specifically audit: `verify-attestation.yml`, `ai-sdlc-review.yml`, `ai-sdlc-gate.yml`, and any others using `on: merge_group`.
- [ ] AC-3: Operator instructions in PR body for the manual repo-settings changes that the operator must perform (since GH API tokens may not have admin scope): (a) Settings → Branches → main branch protection: required status checks = [`ai-sdlc/pr-ready`, `Backlog Drift`], strict=true, remove "Require merge queue"; (b) Settings → General → Pull requests: default merge method = squash, disable merge commits + rebase merges.
- [ ] AC-4: `scripts/sync-branch-protection.sh` (NEW) — idempotent script the operator runs to apply branch protection rules via `gh api -X PATCH /repos/{owner}/{repo}/branches/main/protection`. Includes safety: verifies user has admin permission first; refuses if not.
- [ ] AC-5: CLAUDE.md updates: remove queue-specific paragraphs, document the new direct-merge model. Note that AISDLC-398's content-addressed envelopes + new auto-merge flow eliminate v4-kick permanently.
- [ ] AC-6: `docs/operations/quality-gate.md` updated: remove queue rollup references, document branch protection requirements as the merge gate.
- [ ] AC-7: PR description includes a "Rollback plan" section: if dropping the queue causes problems, re-enable via the operator's "Require merge queue" toggle in branch protection settings (no code revert needed; settings flip).
- [ ] AC-8: Operator runbook section at `docs/operations/merge-without-queue.md` (NEW): explains the new merge flow, when to enable the queue back (if skew becomes a real problem), how to monitor merge-skew via main CI failures.
- [ ] AC-9: Reference AISDLC-398 (content-addressed envelopes) as the prerequisite that made dropping the queue safe (envelopes survive any commit-SHA change, so no v4-kick concern).
- [ ] AC-10: Document AISDLC-399 (conditional update-branch) as obsoleted by this task — close PR when merged and mark 399 task as Superseded.

## Out of scope

- Re-architecting branch protection to use rulesets API (the older required-status-checks API works fine).
- Modifying the merge-queue-specific test infrastructure if any exists.
- Operator-side admin tasks (those are in AC-3 as instructions, not code).

## References

- AISDLC-398 (content-addressed envelopes) — prerequisite
- AISDLC-399 (conditional update-branch) — superseded
- Operator architectural review 2026-05-23
- Industry research: small-team setups (Stripe, Linear, most OSS sub-200-PR/month repos) generally don't use merge queues

## Estimated effort

1-2 days (config + workflow cleanup + docs + helper script).
