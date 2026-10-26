---
id: AISDLC-1070
title: 'fixesPr takeover: an executor given fixesPr pushes to that PR branch instead of opening a new PR'
status: In Progress
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - hierarchy
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/brief-format.ts
  - pipeline-cli/src/types.ts
  - docs/operations/backlog-and-execution-reference.md
---

## Description

RCA 2026-10-23 (0.36.0 release). AISDLC-1059 was dispatched with `fixesPr: 1968` so the executor would take over the hand-made pin-sync PR #1968 (branch `chore/sync-runtime-pins-0-36-0`) and land the pins plus the release-job fix on it. The executor ignored the takeover: it created its own branch and worktree, opened PR #1971 with the same pins, and #1968 was left open and superseded (dispatch had to run close-superseded afterwards). A closed-unmerged PR is a tracked waste KPI, and the takeover path exists precisely to avoid it.

Investigate and fix the whole chain: where `fixesPr` enters (brief YAML, `cli-file`/`auto-brief`, the dispatch manifest), whether `dispatch-loop` copies it into the claim and the resume manifest, whether `execute-pipeline` Step 2 (compute branch) and Step 3 (setup worktree) read it and check out the PR's head branch instead of computing a fresh one, and whether Step 11 (push and PR) pushes to that branch and skips `gh pr create`. Write a test that runs the pipeline steps 1 to 3 and 11 with a `fixesPr` manifest against a fake `gh` and asserts: the branch is the PR's head ref, the worktree tracks it, no new PR is created, the push targets that branch (lease push allowed under DEC-0264). If the branch belongs to a different repository or is protected, the pipeline refuses with a named reason instead of silently falling back to a new branch. Document the field end to end in `docs/operations/backlog-and-execution-reference.md`.

**Five-step review (requirements first).** Requirement questioned: is a separate takeover mode needed, or should every manifest carry an optional head branch? The latter: `fixesPr` resolves to a head branch once, at claim time, and the rest of the pipeline only ever sees a branch. Deletion: any per-step special casing that re-derives the PR. Simplified: resolve once, pass the branch. Accelerated: one PR per fix, no superseded closes. Automated last: the pipeline test with a fake `gh`.

## Acceptance Criteria

- [ ] A manifest with `fixesPr` resolves to that PR's head branch at claim time; Steps 2, 3 and 11 use it: no new branch, no new PR, push to the PR branch; a pipeline test with a fake `gh` asserts all four.
- [ ] A `fixesPr` that names a PR from another repository or a protected branch is refused with a named reason (test).
- [ ] Field documented end to end; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
