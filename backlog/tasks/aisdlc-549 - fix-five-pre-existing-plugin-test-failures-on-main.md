---
id: AISDLC-549
title: >-
  fix(tests): resolve the 5 pre-existing ai-sdlc-plugin test failures on main
  and close the main-health blind spot that let them persist
status: To Do
assignee: []
labels:
  - tests
  - plugin
  - ci
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - ai-sdlc-plugin/agents/rebase-resolver.md
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/scripts/check-orchestrator-state.sh
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Running the plugin's own suite on current main
(`cd ai-sdlc-plugin && node --test hooks/*.test.mjs agents/*.test.mjs
scripts/*.test.mjs commands/*.test.mjs`) yields 485 pass / 5 fail. The five
failures were independently confirmed pre-existing on main during the
2026-06-12 decision-rubric port review (PR #953) and reproduce identically at
head. Exact failing tests:

1. `rebase-resolver body — conflict resolution rules (the 80%)`
2. `/ai-sdlc execute body — pipeline lives inline (AISDLC-98)`
3. `AISDLC-245.4 — no bare hardcoded paths in slash command bodies`
4. `/ai-sdlc orchestrator-tick body — RFC-0041 Phase 1 Dispatch Board protocol`
5. `check-orchestrator-state.sh — plugin/repo-root parity`

These are doc-contract tests: they assert that agent/command markdown bodies
and hook scripts still contain required protocol text, path conventions, and
byte-parity between the plugin copy and the repo-root copy of
check-orchestrator-state.sh. Their failure means either (a) the protected
files drifted and the contracts are genuinely violated (fix the files), or
(b) the bodies evolved legitimately and the assertions are stale (update the
tests to the current contract). Diagnose each of the five individually and
pick per-test — do not blanket-update assertions to match whatever the files
currently say without checking which side regressed.

Second deliverable — the blind-spot question: these failures persist on main
without the main-health monitor flagging them. Determine why
`main-health-monitor.yml`'s full-suite run (`pnpm -r test` + workflow tests)
does not surface plugin `node --test` failures (plugin not a workspace member
for `pnpm -r test`? suite invoked differently? failures swallowed?), and wire
the plugin suite into whichever gate should own it (main-health and/or the
per-PR affected-package path) so a plugin doc-contract regression fails
loudly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All five listed tests pass on the PR branch, each resolved with an explicit per-test call (file regressed vs assertion stale) documented in the PR body
- [ ] #2 Full plugin suite green: `cd ai-sdlc-plugin && node --test hooks/*.test.mjs agents/*.test.mjs scripts/*.test.mjs commands/*.test.mjs` reports 0 failures
- [ ] #3 Root cause of the main-health blind spot identified and documented in the PR body; the plugin suite is wired into main-health and/or per-PR CI so these failures would now turn a gate red
- [ ] #4 Repo verification passes: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`
<!-- AC:END -->
