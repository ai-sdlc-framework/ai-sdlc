---
id: AISDLC-518
title: 'fix(pipeline-cli): stop test runs leaving _artifacts/_captures debris + mutating tracked classifier-corpus'
status: Done
assignee: []
created_date: '2026-06-04'
labels:
  - pipeline-cli
  - test
  - follow-up
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Across every RFC-0043 Phase 7 worktree, running the pipeline-cli test suite left untracked
`pipeline-cli/_artifacts/_captures/cap_*.jsonl` files behind and modified the tracked file
`pipeline-cli/.ai-sdlc/classifier-corpus/pr-comment-is-capture.yaml`. Each reconcile had to
manually `rm` the captures and `git checkout --` the corpus file before staging the
attestation, or they would surface as a dirty tree / `gh pr create` "uncommitted files"
warning. Tests should not write into the tracked tree or a non-ignored artifacts dir.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Identify which capture/classifier tests write to `pipeline-cli/_artifacts/_captures/` and to `.ai-sdlc/classifier-corpus/pr-comment-is-capture.yaml`.
- [ ] #2 Redirect those writes to an isolated `mkdtempSync` dir cleaned up in a `finally` (never the tracked tree, never a shared path), OR add `_artifacts/` to `.gitignore` if it is genuinely a throwaway runtime dir.
- [ ] #3 After a full `pnpm --filter @ai-sdlc/pipeline-cli test` run, `git status --porcelain` shows no new/modified tracked or untracked files in the package.
- [ ] #4 No shared `/tmp/.ai-sdlc` writes introduced (guards the cross-package ancestor-walk pollution class).
<!-- AC:END -->

## Notes

Quality-of-life / hygiene; recurred on all nine Phase 7 reconciles. Relates to the shared-tmp pollution class.
