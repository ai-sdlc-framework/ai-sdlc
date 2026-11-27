---
id: AISDLC-1461
title: auto-enable-auto-merge reads mergeAuthors from the wrong path and arms nothing
status: In Progress
priority: high
labels:
  - ci
  - governance
  - fix
dependencies: []
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - .github/workflows/__tests__/auto-enable-author.test.mjs
  - .ai-sdlc/agent-role.yaml
  - pipeline-cli/src/governance/merge-if-eligible.ts
---

## Description

**Five-step review (requirements first).**
1. Question: AISDLC-1411 (#3105, 345f338f) made the workflow arm only PRs whose author is in `mergeAuthors` of `.ai-sdlc/agent-role.yaml`. The rule stands. But the workflow reads `yq '.governance.mergeAuthors // []'` (`auto-enable-auto-merge.yml:201`) while the key lives at `spec.governance.mergeAuthors` (`agent-role.yaml:7,21,29`; `cli-merge-if-eligible` reads `spec.governance`, `merge-if-eligible.ts:807`). The list is always empty, the guard fails closed, and since 2026-11-27 05:0xZ every PR logs `governance.mergeAuthors is missing or empty on base branch 'main' — skipping (nothing is armed)` (run 45945169486, #3114) while the job reports success. Only the reconciler's arm path remains, which races GitHub's mergeStateStatus lag and routed #3114, #3116, #3119 and #2964 to the planner tonight.
2. Delete: nothing.
3. Simplify: read `.spec.governance.mergeAuthors // []` at line 201 (and fix the comments at lines 81, 195 and the log strings at 210-216 to name `spec.governance.mergeAuthors`). Extend `auto-enable-author.test.mjs` to run the filter against the real `.ai-sdlc/agent-role.yaml` so a path drift fails the test, not production.
4. Accelerate: none.
5. Automate: the new test.

## Acceptance Criteria
- [ ] #1 The workflow's yq filter reads `.spec.governance.mergeAuthors`.
- [ ] #2 A test runs the workflow's filter against the repository's real `agent-role.yaml` and asserts a non-empty list containing the configured authors.
- [ ] #3 Comments and log lines name `spec.governance.mergeAuthors`.
- [ ] #4 After merge, the next PR from a merge author logs "is in spec.governance.mergeAuthors — arming." (verify on the PR that lands this fix or the next one; note the run id in the PR or task).
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
