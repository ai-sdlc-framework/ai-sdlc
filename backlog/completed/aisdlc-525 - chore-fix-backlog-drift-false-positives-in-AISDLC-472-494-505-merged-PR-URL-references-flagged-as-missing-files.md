---
id: AISDLC-525
title: >-
  chore: fix backlog-drift false-positives in AISDLC-472/494/505 (merged PR-URL
  references flagged as missing files)
status: Done
assignee: []
created_date: '2026-06-08 19:03'
labels:
  - chore
  - 'ci:no-issue-required'
dependencies: []
priority: low
updated_date: '2026-06-08 19:30'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three backlog task files carry references pointing to merged GitHub PR URLs that `npx backlog-drift check` resolves as file paths and reports as error-severity "Referenced file no longer exists":

- backlog/completed/aisdlc-472 - ... -> PR 767
- backlog/tasks/aisdlc-494 - ... -> PR 824
- backlog/completed/aisdlc-505 - ... -> PR 843

Impact: the LOCAL pre-push gate `scripts/check-backlog-drift-on-push.sh` runs a full-repo `npx backlog-drift check` and trips on these, forcing unrelated PRs to push with `AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1`. It is non-blocking in CI (the CI "Backlog Drift" gate scopes to the PR's changed tasks), but the local-gate false-positive is friction on every dispatch (observed routinely, incl. AISDLC-522/523/524). This is reference hygiene only — no code/behavioral change.

Root cause: the drift tool treats a GitHub PR URL in a reference position as a file path. Fix options for the implementer to choose: (a) move the PR-URL from the drift-checked `references:` frontmatter into prose in the task body (where drift does not resolve it), or (b) reformat so the drift tool recognizes it as a URL not a path, or (c) drop the dangling PR-URL reference entirely. Pick whichever keeps the audit trail and passes the drift gate; apply consistently to all three. While here, scan `backlog/{tasks,completed}/` for any other tasks with the same merged-PR-URL-as-reference pattern and fix them too so the local gate is fully clean.

Verification: from repo root run `npx backlog-drift check` and confirm ZERO error-severity issues (info/warning are fine). Then confirm a no-arg `git push` of a backlog-touching change no longer needs the skip env var.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 AISDLC-472, AISDLC-494, AISDLC-505 no longer produce error-severity issues under `npx backlog-drift check` (the merged-PR-URL references are moved to body prose, reformatted, or removed — audit trail preserved)
- [x] #2 `npx backlog-drift check` from repo root reports ZERO error-severity issues across the whole repo (any remaining tasks with the same merged-PR-URL-as-reference pattern are fixed in the same pass; info/warning are acceptable)
- [x] #3 No source/code/behavioral change — backlog frontmatter/reference hygiene only; dashboard/ and pipeline-cli/ source untouched
- [x] #4 The local pre-push `scripts/check-backlog-drift-on-push.sh` gate passes WITHOUT `AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1` for a backlog-touching push
<!-- AC:END -->

## Final Summary

## Summary
Removed dangling GitHub PR URL entries from the `references:` frontmatter of three backlog task files (AISDLC-472, AISDLC-494, AISDLC-505). The drift checker was treating `https://` URLs in `references:` lists as file paths and reporting them as error-severity "Referenced file no longer exists", tripping the local pre-push gate on every unrelated dispatch. The PR number is preserved in each task's title so the audit trail is maintained.

## Changes
- `backlog/completed/aisdlc-472 - ...md` (modified): removed `https://github.com/ai-sdlc-framework/ai-sdlc/pull/767` from references
- `backlog/tasks/aisdlc-494 - ...md` (modified): removed `https://github.com/ai-sdlc-framework/ai-sdlc/pull/824` from references
- `backlog/completed/aisdlc-505 - ...md` (modified): removed `https://github.com/ai-sdlc-framework/ai-sdlc/pull/843` from references

## Verification
- `npx backlog-drift check` — ZERO error-severity issues
- No pnpm build/test/lint needed (backlog docs only)

## Follow-up
(none)
