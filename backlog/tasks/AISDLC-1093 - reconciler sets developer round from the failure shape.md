---
id: AISDLC-1093
title: 'reconciler passes --developer-round on failure shapes that need new code (coverage red, test failure, waived tests), so an unchanged patch id no longer strands a fix round'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - pipeline
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28. A resume compares the current patch id with the newest attested envelope (`pipeline-cli/src/next-step/resume-decision.ts`); when equal it returns `unchanged` and neither developer nor reviewers run, only rebase and re-sign. That is right for a BEHIND PR and wrong for coverage red (PR #1910, 87.27% < 89%, needs tests), a failing suite, or a task file whose test line says `waived` (PRs #2026, #2022, #2019): the content must change, so the round must include the developer. Today only `cli-dispatch reenter --developer-round` forces it, the reconciler never passes the flag, and the planner compensates with the prose ruling "Developer pass required" copied into manifest notes by hand. Every fix round for a red PR therefore waits for a planner ruling.

## Fix

**Five-step review (requirements first).** The requirement questioned is "an unchanged patch id keeps its reviews, so skip the developer": true only when the failure is environmental; the real requirement is "the round that runs is the smallest one that can turn the PR green", and the failure shape already says which. Deleted: the prose "Developer pass required" ruling and the planner's hand-copied manifest notes. Simplified: one function `roundForFailure(shape)` in the reconciler decides `push-only | developer`. Accelerated: a coverage-red PR enters a developer round within one tick of the red check instead of after a planner turn. Automated: the shape-to-round table is a test fixture; a new failure shape without a row fails the test, not the drain.

1. `reconcile.ts`: `roundForFailure`: `coverage-patch-below-floor`, `test-failure`, `lint`, `format`, `typecheck`, `waived-tests` (task file line matching `- pnpm test .* waived`) → developer round; `attestation-hash-mismatch`, `behind`, `rate-limited`, `cancelled` → push-only. Unknown shape → developer round (the safer default) and one planner line.
2. `reenter.ts` and `cli/dispatch.ts`: the reconciler passes `--developer-round` with a generated note `Developer round: <shape>: <failing line>`; the manifest note no longer needs the prose marker.
3. `resume-decision.ts`: when `developerRound` is set, the `unchanged` branch is bypassed and the developer prompt includes the failing line and the coverage table for the low files.
4. Waived-tests detection: the reconciler reads the completed task file on the PR head for a waived test line; the developer round's prompt says the waiver is refused on `pipeline-cli/src`, `orchestrator/src`, `ai-sdlc-plugin/hooks` and must be replaced by the real command and summary line.
5. Tests: one row per shape; the live #1910 coverage line and the #2022 waived line as fixtures.
6. `docs/operations/cli-hierarchy.md`: "Fix rounds" subsection with the table; remove the "Developer pass required" wording from `docs/operations/decision-authority.md` if present.

## Acceptance Criteria

- [ ] A PR whose `pr-ready` failure is a patch-coverage line is reentered with `--developer-round` and a note naming the low file, with no planner ruling.
- [ ] A PR whose completed task file carries a waived test line is reentered with a developer round that refuses the waiver.
- [ ] An attestation-hash-mismatch PR is still reentered push-only.
- [ ] No code or docs path contains the string `Developer pass required`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
