---
id: AISDLC-209
title: >-
  PR #346 follow-up — atomicity hardening + CLI input validation in
  completeTaskAtomically
status: Done
assignee: []
created_date: '2026-05-06 04:19'
labels:
  - bug
  - tech-debt
  - pipeline-cli
  - atomicity
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

PR #346 (AISDLC-203) shipped the atomic Codex completion helper. All three reviewers approved, but flagged a cluster of minor + suggestion findings that should be addressed in a follow-up to fully close the bug class.

## Findings to address

### Atomicity
1. **write-before-rename window** (code-reviewer + security-reviewer both flagged) — `patchStatusDone()` writes `status: Done` to `backlog/tasks/<id>.md` before `renameSync` moves it to `completed/`. A crash between the writeFileSync and the renameSync leaves the task in `tasks/` with `status: Done` but never moved. `cli-backlog-verify` would not catch this. Fix: write the patched content to a temp file in `completed/` and rename the temp file to the destination — eliminates intermediate in-place mutation.

2. **Symlink follow without lstat guard** (security-reviewer) — `readFileSync` + `writeFileSync` on `tasks/<id>.md` do not check whether the path is a symlink. A malicious symlink at `backlog/tasks/aisdlc-XXX.md` pointing outside backlog/ would have the rewrite applied to the symlink target. Fix: call `lstatSync` before operating; refuse with a clear error if `isSymbolicLink()`.

### Input validation
3. **Defense-in-depth taskId regex** (security-reviewer suggestion) — although the current code never uses taskId in `path.join` (only as a `startsWith` filter against `readdirSync`), a strict regex check at the CLI entry would (a) fail-fast on operator typos, (b) document the contract for the upcoming workflow patch, (c) immunize against future refactors that might use taskId in path construction.

### Code cleanup
4. **Dead-code in backlog-verify.ts** (code-reviewer) — `idLower.toUpperCase().replace(/^([a-z]+)/, (m) => m.toUpperCase())` — after `toUpperCase()` there are no lowercase characters, so the regex never matches. Simplify to `idLower.toUpperCase()`.

5. **POSIX-only path split** (code-reviewer) — `tasksFile.split('/').at(-1)!` should be `basename(tasksFile)` from `node:path` for portability and clarity.

### Test coverage gaps
6. **Bin shim integration tests are shallow** (code-reviewer + test-reviewer) — `bin-invocation.test.ts` for the new shims only invokes `--help`. Add one end-to-end invocation per shim with a real task ID against a temp dir.

7. **Missing edge cases in complete-task.test.ts** (test-reviewer) — no test for malformed YAML frontmatter, and no test for two files in the same bucket sharing the same task ID prefix.

8. **Optional: renameSync-throws test** (test-reviewer suggestion, low urgency) — guards against future refactors that might split rename into copy+delete.

## Acceptance Criteria
- [ ] #1 completeTaskAtomically writes patched content to a temp file in backlog/completed/ and renames the temp to the final destination — no in-place mutation of the source tasks/ file before rename.
- [ ] #2 lstatSync guard added before any read/write in completeTaskAtomically; symlinks at backlog/tasks/<id>.md are rejected with SymbolicLinkError.
- [ ] #3 CLI bin shim (cli-task-complete.mjs) validates taskId against /^[a-z]+-[0-9]+(?:\.[0-9]+)?$/i at entry and rejects malformed input with non-zero exit.
- [ ] #4 Dead-code replace() in backlog-verify.ts simplified to toUpperCase().
- [ ] #5 tasksFile.split('/').at(-1) replaced with basename(tasksFile) from node:path.
- [ ] #6 bin-invocation.test.ts extended with end-to-end invocation tests for cli-task-complete and cli-backlog-verify against a temp-dir fixture.
- [ ] #7 complete-task.test.ts adds: (a) malformed YAML frontmatter test, (b) duplicate-prefix collision test.
- [ ] #8 (Optional) Mocked renameSync-throws test asserting source remains intact when rename fails — only if time permits.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

Implementation shipped via PR #363. The lifecycle close was lost when the now-retired `.github/workflows/backlog-task-complete.yml` workflow's chore-close PR (#360/#362/#367/#368) failed to auto-merge (one of the orphan-PR cases that motivated AISDLC-220). Moving to `backlog/completed/` retroactively as part of the post-AISDLC-220 sync sweep.
