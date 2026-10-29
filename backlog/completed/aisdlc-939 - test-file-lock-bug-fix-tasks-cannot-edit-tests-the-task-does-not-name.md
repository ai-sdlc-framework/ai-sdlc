---
id: AISDLC-939
title: 'Test-file lock: a task labelled bug cannot edit test files the task does not name'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - hooks
  - governance
  - quality
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
priority: medium
dispatchable: true
---

## Description

A bug fix that edits the failing test instead of the code is the oldest agent failure mode, and today nothing structural prevents it: reviewers are asked to notice it in prose. The playbook gap analysis (2026-10-16, gap 10) proposes a deterministic lock: while the active task carries the `bug` label, the PreToolUse hook denies `Edit`/`Write` on `*.test.*` and `*.spec.*` paths unless the task file names that path (in `references:` or in the body). A bug fix that genuinely needs a new regression test lists the test file in the task; that is the plan.

**Five-step review (requirements first).**
1. Requirement questioned: "reviewers catch test-weakening" (review policy). A reviewer reads a diff after the fact; a lock refuses the write before it happens.
2. Delete: nothing to delete.
3. Simplify: reuse the existing active-task frontmatter reader in `enforce-blocked-actions.js` (`loadPermittedExternalPaths`); add one `labels` read next to it instead of a new parser.
4. Accelerate: the check is a label test plus a glob match, no I/O beyond the task file already read.
5. Automate: deny with a message that names the task file and tells the agent how to lift the lock (add the test path to the task, which is a reviewed change).

Velocity impact: neutral on most tasks (no `bug` label, no check); positive on bug fixes by removing the "test deleted to pass" review round.

## Acceptance Criteria

- [ ] AC-1: With `AI_SDLC_ACTIVE_TASK_ID` set to a task whose `labels` include `bug`, an `Edit` or `Write` on a path matching `*.test.*`, `*.spec.*` or `__tests__/**` is denied unless that repo-relative path appears in the task file (`references:` or body).
- [ ] AC-2: Tasks without the `bug` label, and sessions without an active task, are unaffected (no new denials).
- [ ] AC-3: The denial message names the task file and the two ways to proceed: add the test path to the task, or move the edit to a task without the `bug` label.
- [ ] AC-4: `AI_SDLC_SKIP_TEST_LOCK=1` disables the lock and is logged, in the same style as the other per-gate skips.
- [ ] AC-5: `node --test` cases: bug label + unnamed test (denied), bug label + named test (allowed), no bug label (allowed), no active task (allowed), skip env (allowed, logged).
- [ ] AC-6: `docs/operations/pre-push-and-ci-reference.md` documents the lock in one paragraph; `prompt-rules.js` is NOT edited (this is a hook, not a prompt rule).

## Notes

Origin: playbook gap analysis 2026-10-16 (gap 10).
