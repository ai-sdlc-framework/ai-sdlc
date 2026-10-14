---
id: AISDLC-872
title: 'fix(merge): keep approval and auto-merge across a rebase-only force-push'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [merge, ci, reliability]
dependencies: []
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - pipeline-cli/bin/cli-merge-if-eligible.mjs
  - pipeline-cli/src/attestation/patch-id.ts
  - ai-sdlc-plugin/agents/rebase-resolver.md
  - docs/operations/merge-without-queue.md
priority: critical
dispatchable: true
---

## Context

Source: 24h PR-drain review 2026-10-14 (planner + operator). Operator constraint: stability before unsupervised spend — fixes must be deterministic code or settings, spend zero tokens on their own, and never relaunch or drive sessions.

There were 153 approval dismissals across 16 sampled PRs in 24h. Each lease push after a rebase dismissed the review and disarmed auto-merge, leaving green PRs "ready but unmerged" (about 70 PR-hours). The merge logic is behind `pipeline-cli/bin/cli-merge-if-eligible.mjs` (a shim; the implementation is in the source it forwards to under `pipeline-cli/src`), the workflow is `.github/workflows/auto-enable-auto-merge.yml`, and the patch-id helper is `pipeline-cli/src/attestation/patch-id.ts`.

## Fix

**Five-step review (requirements first).** Requirement questioned: does a rebase-only push, where `git range-diff` against the previous head shows no content change, need a fresh approval at all? The attestation is already keyed on patch-id, so the content-level proof survives a rebase; only the GitHub review and the auto-merge arm are lost. Delete: the re-approval for an unchanged patch-id. Simplify: one predicate, "patch-id equals the one at the last approval or arm", shared by every path. Accelerate: re-arm in the same step as the push instead of waiting for a human or a tick. Automate: no human step remains for a rebase-only push.

1. Implement (a): `auto-enable-auto-merge.yml` and the rebase paths (`/ai-sdlc rebase`, ci-conflict-resolver, `rebase-resolver.md`, `cli-merge-if-eligible --arm`) re-arm automatically when the patch-id is unchanged versus the last armed head. Any content change still requires a fresh review and arm.
2. Decide (b): if GitHub cannot distinguish a rebase-only push, document the branch-protection "dismiss stale pull request approvals" setting as an operator decision in `docs/operations/merge-without-queue.md` (options, trade-off, the evidence above); do not change the setting from code.
3. Record the predicate and the re-arm rule in `docs/operations/merge-without-queue.md`.

## Acceptance Criteria

- [ ] #1 A rebase-only push (identical patch-id) leaves auto-merge re-armed with no human action; covered by tests of the predicate and of each rebase path.
- [ ] #2 A push that changes the patch-id is NOT re-armed automatically.
- [ ] #3 Re-arm goes only through `cli-merge-if-eligible` and its eligibility checks; no new direct merge invocation is introduced.
- [ ] #4 `docs/operations/merge-without-queue.md` documents the rule and the "dismiss stale approvals" operator decision with options.
- [ ] #5 `rebase-resolver.md` instructs the re-arm step without restating prompt rules that live in `prompt-rules.js`.

## Out of scope

- Changing branch-protection settings from code.
- Weakening the eligibility checks (fork, author, base, head-commit, required checks).
- Attestation schema or patch-id exclusion changes.
