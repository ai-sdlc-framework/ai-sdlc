---
id: AISDLC-248.1
title: 'Phase 1: Release runbook + cut release of all publishable workspaces'
status: To Do
assignee: []
created_date: '2026-05-09 19:30'
labels:
  - release
  - phase-1
parentTaskId: AISDLC-248
dependencies: []
priority: high
references:
  - .github/workflows/release.yml
  - release-please-config.json
  - pnpm-workspace.yaml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal
Cut the next release across all publishable workspaces with a coherent version bump and changelog summarizing the May 2026 sprint.

## Acceptance Criteria
<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Audit `pnpm-workspace.yaml` against `release-please-config.json` — every non-private package is tracked or explicitly skipped
- [ ] #2 Every non-private workspace carries `publishConfig.access: public` per CLAUDE.md release rules; `pnpm lint:publishable` passes
- [ ] #3 Determine version bump tier (major/minor/patch) — given the autonomous-orchestrator + cross-harness review additions, this is likely a minor on a 0.x line or major if 1.x
- [ ] #4 Write `CHANGELOG.md` aggregator entry summarizing the sprint: orchestrator (AISDLC-225/226/227/228/232/239/240/241/242/243), Codex cross-harness (AISDLC-247/202.x), TUI (178.x family), Pattern-C MCP (216/234), adoption (245 framework)
- [ ] #5 Operator runbook for the release: how to dry-run via release-please, when to cut, who to notify
- [ ] #6 The release lands on npmjs.org for all publishable packages (verify via `npm view @ai-sdlc/<pkg> version`)
- [ ] #7 GitHub Release notes mirror the changelog summary + link to RFC-0010 / 0012 / 0015 / 0023
<!-- SECTION:ACCEPTANCE:END -->
<!-- SECTION:DESCRIPTION:END -->
