---
id: AISDLC-953
title: 'PR-state classifier recognises the "Detect Changes failed, every downstream gate job skipped" shape as rate-limited when the facts builder carries no job summary'
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
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

On 2026-10-16 between 21:21Z and 21:33Z the reconciler issued `reenter` for PR 1701 (run 38968818462, then 38970090869 on the new head), PR 1698 (run 38968758154) and PR 1699, all three with the same red: the `Detect Changes` job of `ai-sdlc-gate.yml` died in `dorny/paths-filter` with `##[error]API rate limit exceeded for installation`, every downstream gate job (Build and Test, Lint, Attestation, Governance, Integration) was SKIPPED, and `require-issue-link` failed on the same quota. The classifier shipped by the previous rate-limit task (`rateLimitSignature` in `pr-state.ts`) only fires when `RATE_LIMIT_RE` matches `check.summary`; the facts the reconciler builds from the checks rollup carry no summary for those jobs, so the predicate falls through to `real-failure` and each PR cost a full review round that changed nothing. Two of the three PRs are on the release critical path.

**Five-step review (requirements first).**
1. Requirement questioned: must the classifier read annotation text to tell a rate-limited red from a real one? No; when the first gate job fails and every other gate job is skipped, no test ran, so nothing the code can fix was observed.
2. Delete: the dependence on `summary` for this shape; the structural signal is sufficient.
3. Simplify: one more predicate in `classifyPr`, "the only failed gate job is `Detect Changes` (plus optionally `ai-sdlc/issue-link`) and every other gate job is skipped", evaluated before `real-failure`.
4. Accelerate: the facts builder also fills `summary` from the job annotations when the rollup has none, so the existing text predicate works on live data, not only on fixtures.
5. Automate: recorded fixtures from runs 38968818462 and 38970090869 (Detect Changes plus issue-link, all skipped) and one real failure where Build and Test ran and failed, which must stay `real-failure`.

Velocity impact: positive; one rerun replaces one developer plus three reviewer runs per affected PR.

## Acceptance Criteria

- [ ] AC-1: `classifyPr` returns `rate-limited` for a red whose only failed gate job is `Detect Changes` (with or without `ai-sdlc/issue-link`) while every other gate job is `skipped`, even when every `summary` is empty.
- [ ] AC-2: The facts builder fills `summary` from job annotations when the checks rollup provides none, so `rateLimitSignature` matches live runs.
- [ ] AC-3: A red where any gate job after `Detect Changes` ran and failed stays `real-failure`.
- [ ] AC-4: Tests cover AC-1 to AC-3 with fixtures recorded from the three 2026-10-16 runs named above.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` names the structural shape under `rate-limited` and records, as a design note only, that `cli-hierarchy` has no dequeue for a wrong reenter manifest and that any such command needs a governance review before it is built.
