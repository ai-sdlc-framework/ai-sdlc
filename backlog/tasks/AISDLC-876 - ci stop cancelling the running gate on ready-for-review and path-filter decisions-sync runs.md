---
id: AISDLC-876
title: 'ci: stop cancelling the running gate on ready-for-review; path-filter decisions-sync runs'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [ci, velocity]
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/is-docs-only-changeset.mjs
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
---

## Context

Source: 24h PR-drain review 2026-10-14 (planner + operator). Operator constraint: stability before unsupervised spend — fixes must be deterministic code or settings, spend zero tokens on their own, and never relaunch or drive sessions.

85 of 200 gate runs (42.5%) were cancelled. The `ready_for_review` event cancels the in-flight run of the same PR (concurrency group `ai-sdlc-gate-<pr>` with `cancel-in-progress: true` in `.github/workflows/ai-sdlc-gate.yml`), and the `decisions-sync` branch alone produced 84 runs (42%) for append-only event files. Coordinate with AISDLC-867 (records-only fast lane in the gate): that task owns skipping build, test and attestation for record PRs, and this task must not duplicate it. This task covers the draft-to-ready cancel and, only where AISDLC-867 does not already, the run trigger for event-only diffs. If AISDLC-867 has landed and covers it, reduce item 2 to nothing and say so in the PR.

## Fix

**Five-step review (requirements first).** Requirement questioned: "every event always deserves a fresh run". On `ready_for_review` with an unchanged head SHA the earlier run's result is still valid, and event-only diffs carry no code. Delete: the cancellation on a draft-to-ready flip and the full runs for event-only diffs. Simplify: key the concurrency group so a `ready_for_review` run on a head SHA that already has a run does not cancel it. Accelerate: the PR gets its result sooner. Automate: the workflow does it with no operator step.

1. Change the concurrency group or cancel condition so `ready_for_review` never cancels an in-flight run on the same head SHA; `synchronize` on a new SHA still cancels the superseded run.
2. Short-circuit a PR whose diff is only `.ai-sdlc/_decisions/**` using `scripts/is-docs-only-changeset.mjs` or `paths-ignore`, after checking AISDLC-867's lane; extend its classifier, do not fork it.
3. Keep the required rollup `ai-sdlc/pr-ready` reporting in both cases so branch protection is satisfied.
4. Update `docs/operations/quality-gate.md`.

## Acceptance Criteria

- [ ] #1 A draft-to-ready flip on an unchanged head SHA does not cancel the running gate run and the run still ends with `ai-sdlc/pr-ready` posted.
- [ ] #2 A push that changes the head SHA still cancels the superseded run.
- [ ] #3 A PR whose diff is only `.ai-sdlc/_decisions/**` does not start the full gate and still gets `ai-sdlc/pr-ready`; a PR mixing code and event files runs the full gate.
- [ ] #4 A classifier test (and workflow lint) covers the new path rules.
- [ ] #5 `docs/operations/quality-gate.md` describes the concurrency key and the events-only rule.

## Out of scope

- The records-only fast lane itself (AISDLC-867).
- Changing which checks are required, or branch protection.
- Run volume on other branches.
