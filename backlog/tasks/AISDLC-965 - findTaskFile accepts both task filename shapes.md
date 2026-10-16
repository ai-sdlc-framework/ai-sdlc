---
id: AISDLC-965
title: 'findTaskFile accepts both task filename shapes so cli-file briefs ingest'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/cli/dispatch.ts
priority: high
dispatchable: true
---

## Description

`findTaskFile` in `pipeline-cli/src/cli/dispatch.ts` resolves a task id to its backlog file by the prefix `<id> - ` (id, space, dash, space). Tasks filed with `cli-file` are written as `<id>-<slug>.md` (id, dash, slug), so the dispatch tick cannot resolve them, `brief --notify` ingestion fails with a no-match for every task on the brief, and the dispatch session has to write each manifest by hand (`write-manifest`). This hit the 11-task brief `tasks-aisdlc-954-plus-10` and the earlier `tasks-aisdlc-953` brief.

**Five-step review (requirements first).**
1. Requirement questioned: must the task filename encode the title with a literal ` - `? No; the id is the only part the resolver needs, and both shapes already coexist in `backlog/tasks/` (101 files with ` - `, 11 slug-shaped files written by `cli-file`).
2. Delete: nothing to delete; the hand-written `write-manifest` workaround in the dispatch session stops being needed.
3. Simplify: one resolver rule, "the filename starts with the lowercase id followed by a non-id character (` `, `-`, `.`)", instead of a fixed three-character separator. `AISDLC-95` must not match `aisdlc-954-...`.
4. Accelerate: a brief of n tasks ingests in one tick instead of n manual manifest writes.
5. Automate: a unit test covers both shapes and the prefix-collision case (`AISDLC-95` vs `aisdlc-954`, `AISDLC-631` vs `aisdlc-631.1`).

## Acceptance Criteria

- [ ] `findTaskFile(workDir, 'AISDLC-954')` returns `backlog/tasks/aisdlc-954-<slug>.md` and `findTaskFile(workDir, 'AISDLC-962')` keeps returning the ` - ` shape.
- [ ] `findTaskFile(workDir, 'AISDLC-95')` returns undefined when only `aisdlc-954-...` exists; `AISDLC-631` does not match `aisdlc-631.1 - ...`.
- [ ] A Vitest case in the dispatch test file covers the three cases above.
- [ ] `cli-hierarchy brief --tasks <cli-file-filed id> --notify` followed by a dispatch tick puts the manifest on the board without a manual `write-manifest` (verified by the existing brief-ingest test, extended with a slug-shaped fixture).

## Affected surface

`pipeline-cli/src/cli/dispatch.ts` (`findTaskFile`) and its test; no workflow, hook or config change.
