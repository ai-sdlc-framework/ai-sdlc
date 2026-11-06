---
id: AISDLC-1195
title: 'Verdict-check skips only the exact release-please branch, not any release-please-- prefix'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0061
  - review-gate
  - ci
  - security
  - fix
dependencies:
  - AISDLC-1172
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/__tests__/ai-sdlc-gate.test.mjs
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: high
dispatchable: true
---

## Description

**Source.** Planner, 2026-11-06, from the stopped AISDLC-1172 repair round. Its executor wrote this fix as local commit dc9fc4c7 in the 1172 worktree after the PR had merged; dispatch stopped the round, so the fix never reached origin.

**Gap on main.** The `verdict-check` job in `ai-sdlc-gate.yml` (the review-verdict gate that `ai-sdlc/pr-ready` now requires) skips any same-repo PR whose head branch starts with `release-please--`. A skipped job counts as success in the rollup. So any same-repo branch named `release-please--<anything>` merges with no review verdict. The only release branch this repo uses is `release-please--branches--main` (release PR #2250 and every earlier release PR). This is a tightening (decision-authority class (a)).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the release PR skips the verdict check because release-please writes it and no reviewer runs on it; nothing else needs the skip. 2. Deleted: the prefix match. 3. Simplified: one exact comparison. 4. Accelerated: none. 5. Automated: a workflow test pins it.

1. In the `verdict-check` job `if:`, replace `!startsWith(github.event.pull_request.head.ref, 'release-please--')` with `github.event.pull_request.head.ref != 'release-please--branches--main'`, keeping the same-repo condition. Commit dc9fc4c7 in the AISDLC-1172 worktree has the exact one-line change.
2. Update the job comment to say only the same-repo `release-please--branches--main` PR skips.
3. Add a test in `ai-sdlc-gate.test.mjs` asserting the job condition uses the exact branch name and does not use a `startsWith` prefix on `release-please--`.
4. Check the other jobs in the workflow for the same `startsWith(..., 'release-please--')` skip on a required gate, and apply the same exact match to each; list them in the PR body.

## Acceptance Criteria

- [ ] AC-1: A same-repo PR from `release-please--evil` runs the verdict-check job; the `release-please--branches--main` PR still skips it. Shown by the workflow test.
- [ ] AC-2: No required gate in `ai-sdlc-gate.yml` skips on a `release-please--` prefix match.
- [ ] AC-3: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass.
