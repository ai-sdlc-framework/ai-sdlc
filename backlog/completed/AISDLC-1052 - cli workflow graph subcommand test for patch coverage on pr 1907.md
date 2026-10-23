---
id: AISDLC-1052
title: 'Add the CLI-level test for the cli-workflow graph subcommand so PR #1907 passes the patch coverage gate'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline-cli
  - tests
  - fixes-pr
dependencies: []
references:
  - pipeline-cli/src/cli/
  - scripts/check-pr-patch-coverage.mjs
priority: high
dispatchable: true
---

## Description

PR #1907 (branch `ai-sdlc/aisdlc-991-workflow-graph-phase-1-step-metadata-and-cli-workf`, head 3e7bb2056) is complete and reviewer-approved, and every test suite passes on it, but the Build & Test job fails at its last step:

```
[patch-coverage] pipeline-cli/src/cli/workflow.ts: 2/20 (10.0%)
[patch-coverage] TOTAL: 144/162 lines covered (88.89%)
[patch-coverage] FAIL: patch coverage 88.89% < 89% threshold.
```

Every other changed file is at 100%; the new CLI entry `pipeline-cli/src/cli/workflow.ts` (the `graph` subcommand that emits the execute Machine as Mermaid and YAML) has no test that runs it through the command entry. A reenter cannot fix this: the resume path compares patch ids only and skips the developer when nothing changed, which is why the first reenter ran no developer round.

This task runs ON the PR's branch (dispatch rewrites the queued manifest with that branch and `fixesPr: 1907` before claim). Work: add `pipeline-cli/src/cli/workflow.test.ts` that invokes the `graph` subcommand through the command entry for the Mermaid output path, the YAML output path and the error path (unknown format or missing machine), asserting on the emitted text; no production change. Before pushing, run `node scripts/check-pr-patch-coverage.mjs --base $(git merge-base origin/main HEAD) --head HEAD` and confirm `workflow.ts` appears in the table at or above the threshold (new files must show in the local coverage table). The push lands on PR #1907, which then goes green and lands; this task's file moves to completed in the same PR.

**Five-step review (requirements first).** Requirement questioned: is the 89% patch gate the right bar for a CLI wrapper? Yes; CI is the single coverage gate and it is not waived locally. Deletion: nothing to delete; no production code changes. Simplified: one test file for one entry point, three paths. Accelerated: the test runs the entry in-process, no subprocess. Automated last: the existing patch-coverage step already enforces it.

## Acceptance Criteria

- [ ] `pipeline-cli/src/cli/workflow.test.ts` covers the Mermaid path, the YAML path and the error path of the `graph` subcommand through the command entry.
- [ ] `node scripts/check-pr-patch-coverage.mjs` against the merge base reports `workflow.ts` at or above the threshold and TOTAL at or above 89%.
- [ ] The commit is pushed to PR #1907's branch; `ai-sdlc/pr-ready` is green on #1907; no new PR is opened.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
