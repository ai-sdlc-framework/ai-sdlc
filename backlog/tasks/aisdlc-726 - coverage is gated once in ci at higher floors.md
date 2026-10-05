---
id: AISDLC-726
title: >-
  Coverage is gated once, in CI, at higher floors
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - ci
  - governance
dependencies: []
references:
  - scripts/check-coverage.sh
  - scripts/check-pr-patch-coverage.mjs
  - codecov.yml
  - .husky/pre-push
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Coverage runs on the Stop hook, up to three times on push, and twice in CI. Line coverage on main (2026-10-05) is: reference 94.65, orchestrator 93.94, pipeline-cli 93.58, mcp-server 94.84, mcp-advisor 95.97, sdk-typescript 100, dogfood 91.07, dashboard 89.21, conformance runner 87.50. Only three packages have a floor (80) and the patch gate is at 80. Per DEC-0056 (row 2 and the coverage floors) the local runs are deleted and the CI floors are raised to hold the current level.

The workflow edits in this task land after the operator's agent-role config edit is on main.

## Conventions
- Hermetic tests; temporary directories come from `mkdtemp`.
- CLAUDE.md edits are authorized for the Hooks list and the Testing section only.

## Acceptance Criteria
- [ ] The pre-push coverage gate (`scripts/check-coverage.sh` in the `.husky/pre-push` chain) and the Stop-hook coverage run (the deferred coverage check registered by the plugin) are removed, with their tests, wiring and environment variables; nothing runs coverage automatically on a developer machine.
- [ ] Vitest line thresholds: 90 for reference, orchestrator, pipeline-cli, mcp-server, mcp-advisor and sdk-typescript; 85 for dogfood, dashboard and the conformance runner. Existing branch, function and statement thresholds are not lowered. Each of the nine packages has a line floor.
- [ ] The patch coverage gate (`scripts/check-pr-patch-coverage.mjs` as invoked by the gate workflow) uses threshold 90, and `codecov.yml` patch target matches. The rule that a changed file with no coverage entry fails the gate is reviewed: list which file kinds trip it and either instrument them or add them to the non-instrumented patterns, so the higher bar does not multiply false failures.
- [ ] Developer agent instructions state: the coverage requirement for packages you touch is 95 percent lines, and you run coverage for those packages once before your first push. The instructions do not claim that CI enforces 95.
- [ ] CLAUDE.md's Hooks list and Testing section are updated to match (this task authorizes that edit, limited to those sections); docs that describe the local coverage gate and its skip variable are corrected.
- [ ] The two open tasks about the local gates become unnecessary: note in the PR that the stale-coverage-summary task and the Stop-hook index task are closed by this change, and move their files to completed in the same PR if the pipeline allows it.
- [ ] PR body carries a "Velocity impact" section: local coverage runs removed per PR, and the headroom between each floor and current coverage.

## Out of scope
- Branch-coverage targets.
- Coverage for code outside the nine packages.
<!-- SECTION:DESCRIPTION:END -->
