---
id: AISDLC-1010
title: >-
  Landing-gate audit is cwd-relative, so records scatter across worktrees or are lost
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - governance
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - docs/operations/merge-without-queue.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-21 17:30Z, from an adopter report).** The landing gate writes its audit record to `$ARTIFACTS_DIR` or `<cwd>/artifacts/_governance/merge-audit-*.jsonl`. Dispatch, executors and the reconciler call the gate from worktrees and other working directories, so the records scatter across `.worktrees/*/artifacts/` and vanish with the worktree sweep. The adopter repo has one record for 2026-10-20 and none for the four landings of 2026-10-21. An audit nobody can find is a step a human has to redo by reading GitHub.

**Five-step review (requirements first).**
1. Requirement questioned: "the audit lives next to the caller". The gate already resolves the trusted root (the main checkout) to read policy; the audit belongs at the same root.
2. Delete: the cwd-relative default.
3. Simplify: the audit path is `<trusted-root>/artifacts/_governance/merge-audit-<date>.jsonl`; `$ARTIFACTS_DIR` stays as an explicit override. One helper returns the path; every writer uses it.
4. Accelerate: one place to read for every landing, from any session.
5. Automate: none.

**Velocity impact.** Neutral on speed, positive on diagnosis time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Running the gate from a linked worktree writes the audit record under the main checkout's `artifacts/_governance/`, not under the worktree; unit test with a fake worktree layout
- [ ] #2 `$ARTIFACTS_DIR` still overrides the location when set; unit test
- [ ] #3 `docs/operations/merge-without-queue.md` names the audit location and the override
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
