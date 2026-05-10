---
id: AISDLC-249
title: Add --skip-git-repo-check to Codex reviewer agent bodies
status: To Do
assignee: []
created_date: '2026-05-09'
labels:
  - codex
  - bug
  - reviewer
  - aisdlc-202.4-followup
parentTaskId: AISDLC-202
dependencies: []
references:
  - ai-sdlc-plugin/agents/code-reviewer-codex.md
  - ai-sdlc-plugin/agents/test-reviewer-codex.md
  - docs/operations/cross-harness-review.md
priority: medium
---

## Problem

The Codex reviewer agent bodies (`code-reviewer-codex.md`, `test-reviewer-codex.md`) do not document or use the `--skip-git-repo-check` flag in their `codex exec` invocations.

The smoke-test pilot on PR #415 (AISDLC-242, 2026-05-09) confirmed that `--skip-git-repo-check` is required in environments where Codex CLI performs a GitHub repo authentication check before allowing `exec` to run. Without this flag, the `codex exec` invocation exits non-zero, causing the reviewer to return a critical error envelope instead of an actual review.

## Goal

Add `--skip-git-repo-check` to the `codex exec` invocation in both reviewer agent bodies so the review path works out of the box in all environments.

## Acceptance Criteria

- [ ] #1 `code-reviewer-codex.md` Step 4 invocation includes `--skip-git-repo-check`.
- [ ] #2 `test-reviewer-codex.md` Step 4 invocation includes `--skip-git-repo-check`.
- [ ] #3 `docs/operations/cross-harness-review.md` "Known flags required" table updated to note this flag is now included by default in the agent bodies (not operator-added).
- [ ] #4 Smoke-test the change by running `code-reviewer-codex` in an environment that would have previously required the flag manually.
