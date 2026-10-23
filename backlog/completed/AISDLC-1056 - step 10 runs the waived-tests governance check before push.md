---
id: AISDLC-1056
title: 'Step 10 runs the waived-tests governance check locally so a task file that waives pnpm test on pipeline code never reaches CI'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - governance
  - velocity
dependencies: []
references:
  - scripts/check-pr-governance.mjs
  - pipeline-cli/src/steps/10-finalize.ts
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
---

## Description

Twice on 2026-10-23 (PR #1942 for one task, PR #1960 for another) a delivered code PR went red only on the Governance gate's `waived-tests` check: the developer had written the verification section of the completed task file with `pnpm test` recorded as waived or skipped while the diff touched `pipeline-cli/src` or `ai-sdlc-plugin/hooks`. Each time the fix was a reenter, a developer round that reran the suite and rewrote one line, a re-sign and a push: about one executor hour and a planner ruling per occurrence, for a condition `scripts/check-pr-governance.mjs` can decide from the worktree alone.

Shift the check left. Step 10 (finalize), which already moves the task file to `backlog/completed/` and writes its verification section, runs the same `waived-tests` check (`node scripts/check-pr-governance.mjs waived-tests --task-file <path> --base origin/main` or the equivalent function import) before the attestation sign and the push. On a hit it fails the step with the gate's own message, so the developer round that follows has the exact line to fix and the PR never opens red. The CI check stays as the independent control; nothing is removed from CI.

**Five-step review (requirements first).** Requirement questioned: should a test waiver on pipeline code be representable in a task file at all? The gate rule (AISDLC-1022) already says no for those paths; this task only moves where it is enforced. Deletion: nothing to delete; the CI check remains the control. Simplified: one call to the existing checker from Step 10, no second implementation. Accelerated: the finding arrives before the push instead of after a CI run, a reenter and a re-sign. Automated last: a Step 10 test with a task file that waives `pnpm test` and a diff touching `pipeline-cli/src` asserts the step fails with the gate message; a docs-only diff with the same wording passes.

## Acceptance Criteria

- [ ] Step 10 runs the `waived-tests` check from `scripts/check-pr-governance.mjs` against the completed task file and the diff before sign and push, and fails with the gate's message on a hit.
- [ ] Tests cover the hit (pipeline code touched) and the pass (docs-only diff) cases.
- [ ] `docs/operations/quality-gate.md` states that the check runs locally in Step 10 and again in CI.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
