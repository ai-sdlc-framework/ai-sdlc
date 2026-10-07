---
id: AISDLC-704.3
title: >-
  replace shell-string exec with execFile argument arrays in three second-order injection sites
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
Follow-up from AISDLC-704 (code-scanning triage). Fix code-scanning alerts 180 (`pipeline-cli/src/steps/11-late-rebase.ts`), 176 (`orchestrator/src/runtime/git-env.ts`) and 167 (`orchestrator/src/execute.ts`): pass values as argument arrays (no shell interpolation), review each site, add tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.

## Final Summary

## Summary
Hardened the three flagged git call sites against second-order option injection: `--` end-of-options on `git fetch`, a leading-`-` guard on lateRebase's targetBranch, and a transport-command argument guard in gitExecFile. The sites already used execFile argument arrays, so the fix is option-injection hardening.

## Changes
- `orchestrator/src/execute.ts` (modified): `git fetch -- origin <branch>` at two sites
- `orchestrator/src/runtime/git-env.ts` (modified): `assertNoTransportCommandArgs` guard in gitExecFile
- `pipeline-cli/src/steps/11-late-rebase.ts` (modified): `--` separator and targetBranch `-` guard
- matching test files (modified)

## Design decisions
- **`--` separator is the primary defense**: the gitExecFile denylist is a backstop only (does not cover abbreviations).

## Verification
- `pnpm build`, `pnpm test` (affected suites), `pnpm lint`, `pnpm format:check` — passed (developer)
- 3 parallel reviews approved (codex quota exhausted; Claude-native code/test reviewers used)

## Follow-up
Alerts 180, 176, 167 read `fixed` only after a CodeQL re-scan post-merge. declined: broadening the denylist to abbreviations (minor, backstop only).
