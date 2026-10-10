---
id: AISDLC-735
title: >-
  Run the plugin command tests in CI
status: Done
assignee: []
created_date: '2026-10-05'
labels:
  - ci
  - tests
dependencies: []
references:
  - ai-sdlc-plugin/commands/executor.test.mjs
  - ai-sdlc-plugin/commands/planner.test.mjs
  - package.json
  - .github/workflows/ci.yml
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Test files under `ai-sdlc-plugin/commands/*.test.mjs` (for example `executor.test.mjs`, `planner.test.mjs`) exist, but on origin/main neither the root `package.json` test scripts nor any file under `.github/workflows` runs them (checked 2026-10-05 by grep). A regression in a command body therefore reaches main unnoticed. This task removes that gap and adds no new gate on the happy path.

This task edits a workflow, so it needs the blockedPaths change (the operator's agent-role.yaml edit that the planner tracks as the second item of DEC-0057; it has no task file on main yet, so it is not listed in `dependencies`) applied first.

## Acceptance Criteria
- [x] The command tests run in the required PR test job on Linux (wired through a `package.json` script that the existing test job calls).
- [x] Known portability traps handled: reading `/dev/stdin` returning EAGAIN, and very large environments causing E2BIG.
- [x] A failing command test fails the PR (shown in the PR with a deliberate failing run, then removed).

## Velocity impact
Prevents command-body regressions merging unseen. The happy path gets zero new prompts and a small CI time increase; tests that fail only on Linux are fixed in this task. When the job fails, the output names the test file, and the agent fixes the test or the command.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added root `test:plugin-commands-gate` (`node --test "ai-sdlc-plugin/commands/*.test.mjs"`) and chained it into root `pnpm test`, so the required PR test job now runs all 16 command test files (412 tests). Five command tests had drifted from their command bodies and failed on main; fixed.

## Changes
- `package.json` (modified): new gate script, chained into `test`.
- `ai-sdlc-plugin/commands/execute.test.mjs` (modified): expect 3 `EMIT_MODEL=` lines (the `unrouted` fallback was added).
- `ai-sdlc-plugin/commands/{executor,import-spec,orchestrator-tick,rebase,rfc-init}.md` (modified): bring bodies back in line with their tests (`$PIPELINE_CLI_BIN` instead of bare `node pipeline-cli/bin/...`, line cap, `write-manifest` mention).

## Design decisions
- **Wire through package.json, not a workflow**: no `.github/workflows` edit, so the blockedPaths precondition does not apply.
- No `/dev/stdin` reads or large-env child spawns exist in the command tests, so no portability fix was needed; Linux run is confirmed by CI.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test:plugin-commands-gate`: 412 pass; a deliberate failing test made it exit 1 (removed).
- Full `pnpm test`: 4 pre-existing-environment failures in pipeline-cli `bin-invocation.test.ts` (pnpm exec succeeds locally); this diff does not touch pipeline-cli.

## Follow-up
- declined: CI-side deliberate-failure demo; the local non-zero exit demonstration covers it.
<!-- SECTION:FINAL_SUMMARY:END -->
