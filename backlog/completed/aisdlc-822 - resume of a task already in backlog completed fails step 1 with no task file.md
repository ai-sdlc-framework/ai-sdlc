---
id: AISDLC-822
title: >-
  Resume of a task whose file is already in backlog/completed fails Step 1 with "no task file": validateTask must honour the completed location like Steps 4 and 10 do
status: Done
assignee: []
created_date: '2026-10-12'
labels:
  - pipeline
  - fix
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/steps/01-validate.ts
  - pipeline-cli/src/steps/04-flip-status.ts
  - pipeline-cli/src/steps/10-finalize.ts
priority: critical
dispatchable: true
---

## Description

Filed under the DEC-0127 drain exception (a new PR only to land existing PRs).

A resumed task whose branch already carries the Done move (task file in `backlog/completed/`, not in `backlog/tasks/`) is refused at Step 1 with `no task file for <id>`. `validateTask()` in `pipeline-cli/src/steps/01-validate.ts` resolves the file with `findTaskFile()` only, which scans `backlog/tasks/`. The same module exports `isTaskFileCompleted()` (AISDLC-738), and Steps 4 and 10 already use it to accept the completed location on a resume; Step 1 was never given the same rule. During the 2026-10-12 drain this blocked the full-pipeline fallback for AISDLC-631.6 (DEC-0133), AISDLC-799 (DEC-0134) and AISDLC-713: each needed a reviewer round on a rebased head and the pipeline could not even start.

**Five-step review (requirements first).**
1. Requirement questioned: "the task file lives in `backlog/tasks/` at Step 1" was an assumption of the first-run path, set by nobody for resumes; AISDLC-738 already decided a resumed task may carry its Done move.
2. Delete: the separate first-run-only lookup in Step 1. One resolver, used by Steps 1, 4 and 10, that returns the path in `backlog/tasks/` or, on resume, in `backlog/completed/`.
3. Simplify: `findTaskFile(taskId, workDir, { includeCompleted })` (or a sibling `findTaskFileForResume`) replaces the three call sites' ad hoc logic; `validateTask` receives the resume flag the executor already passes to Steps 4 and 10.
4. Accelerate: none beyond removing the refusal.
5. Automate: none.

Velocity impact: positive; every reviewers-only or full resume of a PR that already moved its task file becomes possible without hand work. Governance impact: none; the lookup location changes, the Done semantics (AISDLC-220/738) and every gate are unchanged.

## Acceptance Criteria

- [ ] AC-1: On a resume (`resume: true`), `validateTask()` accepts a task file found in `backlog/completed/` when none exists in `backlog/tasks/`, and parses it exactly as a `backlog/tasks/` file.
- [ ] AC-2: On a first run (no resume flag) the behaviour is unchanged: a task only in `backlog/completed/` is still refused with `no task file for <id>`.
- [ ] AC-3: Steps 1, 4 and 10 resolve the file through one shared helper; no step keeps its own copy of the completed-directory scan.
- [ ] AC-4: Hermetic tests cover AC-1 and AC-2 for Step 1 and keep the existing Step 4 and Step 10 cases green.
- [ ] AC-5: The PR body names the five steps above and lists the three tasks this unblocks (AISDLC-631.6, 799, 713).

## Notes

(none)
