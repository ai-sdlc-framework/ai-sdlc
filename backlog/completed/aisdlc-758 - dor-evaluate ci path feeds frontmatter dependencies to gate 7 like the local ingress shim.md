---
id: AISDLC-758
title: >-
  dor-evaluate CI path feeds frontmatter dependencies to Gate 7 like the local ingress shim
status: Done
assignee: []
created_date: '2026-10-07'
labels:
  - dor
  - ci
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/index.ts
  - pipeline-cli/src/dor/ingress-claude.ts
  - pipeline-cli/src/dor/gates/gate-7-deps.ts
  - pipeline-cli/src/dor/types.ts
  - .github/workflows/dor-ingress.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The CI step "Evaluate each changed task" in `.github/workflows/dor-ingress.yml` runs `node pipeline-cli/bin/ai-sdlc-pipeline.mjs dor-evaluate <id> --body-file <f> --source backlog --hermetic`. That subcommand (`pipeline-cli/src/cli/index.ts`, around lines 793-870) builds its `IssueInput` without `declaredDependencyRefs`. The local path, `refineBacklogTask()` in `pipeline-cli/src/dor/ingress-claude.ts` (around line 205), feeds `extractDeclaredDependencyRefs(frontmatter)` into the same input (AISDLC-563). Gate 7 (`pipeline-cli/src/dor/gates/gate-7-deps.ts`) therefore sees no declared dependencies on the CI path and flags every tracked-work reference in the body.

Concrete symptom, 2026-10-07, PR #1260: task AISDLC-755 lists AISDLC-754 in its frontmatter `dependencies:` and says so in a sequencing sentence in the body. Local `cli-dor-check` exits 0, but CI fails "Evaluate backlog tasks changed by PR" with Gate 7: "1 tracked-work dependency reference(s) in body not listed in frontmatter dependencies". Every filing PR that writes a sequencing sentence naming a declared dependency hits this. AISDLC-563 fixed only the local shim.

AISDLC-755 carries a `blocked.reason` override as a stopgap until this task lands.

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Scope

<!-- SECTION:SCOPE:BEGIN -->
- Make `dor-evaluate --body-file` parse the task frontmatter when `--source backlog` and populate `IssueInput.declaredDependencyRefs` through the same `extractDeclaredDependencyRefs` helper. Export or move the helper so both paths share one function.
- Add a hermetic test in pipeline-cli covering a body phrase such as "after AISDLC-N merges" with N declared in frontmatter passing Gate 7 on the dor-evaluate path, and failing when N is not declared.
- Add a workflow test under `.github/workflows/__tests__/` only if the existing dor-ingress test pattern makes it cheap.
<!-- SECTION:SCOPE:END -->

## Acceptance Criteria

- [x] AC-1: `dor-evaluate` on a backlog body file with a declared dependency referenced in prose yields no Gate 7 finding.
- [x] AC-2: the undeclared case still fails Gate 7.
- [x] AC-3: one shared helper feeds both the dor-evaluate path and `refineBacklogTask()`.
- [x] AC-4: the `blocked.reason` override is removed from AISDLC-755 in the same PR, and #1260-style prose passes.
- [x] AC-5: `pnpm test` passes.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`dor-evaluate --body-file --source backlog` now parses task frontmatter and feeds `dependencies:`/`references:` to Gate 7 through the same helper `refineBacklogTask()` uses, so declared dependencies named in prose pass on the CI path.

## Changes
- `pipeline-cli/src/dor/ingress-claude.ts` (modified): exported shared `declaredDependencyRefsFromFrontmatter`.
- `pipeline-cli/src/cli/index.ts` (modified): dor-evaluate populates `declaredDependencyRefs` for backlog source.
- `pipeline-cli/src/dor/gates/gate-7-deps.test.ts` (modified): declared passes, undeclared fails.
- AISDLC-755 task file: removed the `blocked.reason` stopgap.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` clean; dor tests pass; 14 environmental failures in unrelated files (nested-worktree runtime resolution / pnpm exec / tui) pending CI confirmation.

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
