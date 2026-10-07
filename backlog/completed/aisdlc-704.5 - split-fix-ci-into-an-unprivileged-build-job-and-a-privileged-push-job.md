---
id: AISDLC-704.5
title: >-
  split fix-ci into an unprivileged build job and a privileged push job
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). AISDLC-704 removed the untrusted checkout from `ai-sdlc-fix-ci.yml` but the pipeline step still holds the write PAT, the job token and ANTHROPIC_API_KEY while the agent runs PR-branch code, and git hooks can run during the final push. Run PR code in a job with no secrets and hand off through an artifact; push from a separate privileged job (at minimum `git -c core.hooksPath=/dev/null push --no-verify`). Also from the AISDLC-704 security review: add `--ignore-pnpmfile` to the pr-work install (and correct the test/comment claiming scripts cannot run), skip the diagnostics copy when the path is a symlink, give the pr-work install its own pnpm store or no cache, and build PR code in pr-work with no secrets if validation needs dist output.

Additions from the AISDLC-704 security review: `.pnpmfile.cjs` in PR code can write `$GITHUB_ENV` and `$GITHUB_PATH`, so `--ignore-pnpmfile` alone is not enough (the unprivileged job must not export those files, or must run with them unset); `core.hooksPath` set by the trusted `prepare` step lets a PR-branch husky hook run on the final push, so the privileged job must push with `-c core.hooksPath=/dev/null`; and the diagnostics `cp` follows symlinks, so copy with symlink-following disabled or skip symlinked paths.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The change described above is implemented with tests.
- [x] The listed code-scanning alerts read `fixed` after merge.
- [x] The unprivileged job does not export `$GITHUB_ENV` or `$GITHUB_PATH` (or runs with them unset), in addition to `--ignore-pnpmfile`.
- [x] The privileged job pushes with `-c core.hooksPath=/dev/null`.
- [x] The diagnostics copy does not follow symlinks (disabled or symlinked paths skipped).

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Split `ai-sdlc-fix-ci.yml` into an unprivileged agent job (`fix-ci`, read-only contents, no write PAT, no pnpm cache) and a privileged `push-fix` job that fetches the fix as a git bundle (data), verifies fast-forward, rejects `.github/`, `.husky/` and `.ai-sdlc/` changes, and pushes with `-c core.hooksPath=/dev/null --no-verify`.

## Changes
- `.github/workflows/ai-sdlc-fix-ci.yml` (modified): two-job split, `--ignore-pnpmfile` plus private store on the pr-work install, runner file-command variables unset in PR-code steps, symlink-safe diagnostics copy.
- `orchestrator/src/fix-ci.ts`, `dogfood/src/cli-fix-ci.ts` (modified): `skipPush` option driven by `AI_SDLC_FIX_CI_SKIP_PUSH`.
- Tests in `fork-pr-safety.test.mjs`, `fix-ci.test.ts`, `cli-fix-ci.test.ts`.

## Design decisions
- **ANTHROPIC_API_KEY stays in the agent job**: the agent needs it; the write PAT does not. Residual risk documented in the workflow comments.
- **Success comment moves to push-fix** with the retry marker; the cycle marker is not carried.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` clean; workflow tests 435 pass; fix-ci tests pass.
- 3 reviewers approved (round 2).

## Follow-up
declined: path guard is a denylist and the API key shares a job with PR code (pre-existing); both noted as residual in review.
<!-- SECTION:FINAL_SUMMARY:END -->
