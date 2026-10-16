---
id: AISDLC-949
title: 'PR-state classifier recognises the installation rate-limit red (short Detect Changes or issue-link job with "API rate limit exceeded for installation") as rate-limited, never as real-failure'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - reconciler
  - cost
dependencies: []
references:
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

On 2026-10-16 the PR-state classifier labelled two of two red PRs in one window (PR 1652 at 19:29Z, PR 1687 at 19:20Z) as `real-failure`. The real FAIL line on both was `##[error]API rate limit exceeded for installation` in the Detect Changes job, which ran for 6 to 8 seconds; `ai-sdlc/issue-link` failed in the same window for the same reason, and `ai-sdlc/pr-ready` only rolled the two up. The reconciler then issued a `reenter` for PR 1652, which re-ran the developer and the full reviewer set on a diff that had not changed. The 48-hour usage audit priced this resume-after-green pattern at roughly a quarter of all spend, and the installation quota resets every hour on its own.

**Five-step review (requirements first).**
1. Requirement questioned: should a red check ever send a PR back to an executor without reading why it is red? No; a reenter is justified only by a failure the code can fix.
2. Delete: the default that an unknown red is `real-failure`; a red whose failing jobs all carry a rate-limit signature is `rate-limited`.
3. Simplify: one predicate on the failing jobs of the gate run, "every failing job finished in under 30 s and its annotation or log matches `API rate limit exceeded`", reusing the run-id lookup AISDLC-945 adds; no new state.
4. Accelerate: `rate-limited` maps to the existing `rerun-rate-limited` action after the quota reset time (`x-ratelimit-reset` or the next full hour), never to `reenter`.
5. Automate: fixture tests for the two observed shapes (Detect Changes alone; Detect Changes plus issue-link) and one for a genuine test failure that must stay `real-failure`.

Velocity impact: positive; a rate-limited PR recovers with one rerun instead of one developer plus three reviewer runs.

## Acceptance Criteria

- [ ] AC-1: `pr-state.ts` classifies a red PR whose failing jobs all match the rate-limit signature (duration under 30 s and annotation or log containing `API rate limit exceeded`) as `rate-limited`, not `real-failure`.
- [ ] AC-2: `reconcile.ts` maps `rate-limited` to `rerun-rate-limited` scheduled at or after the quota reset and never issues `reenter` for it.
- [ ] AC-3: A red with at least one failing job that does not match the signature stays `real-failure`.
- [ ] AC-4: Tests cover the three cases in AC-1 to AC-3 with recorded fixtures from PR 1652 and PR 1687.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` lists `rate-limited` and its action.

## Notes

Origin: dispatch blocker notes 2026-10-16 19:20Z to 19:35Z; planner usage audit of the same day. Related: AISDLC-945 (rerun command), AISDLC-934 (workflow fan-out that exhausts the installation quota).
