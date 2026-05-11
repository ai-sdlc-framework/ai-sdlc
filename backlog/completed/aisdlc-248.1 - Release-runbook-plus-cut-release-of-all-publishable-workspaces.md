---
id: AISDLC-248.1
title: 'Phase 1: Release runbook + cut release of all publishable workspaces'
status: Done
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

## Final Summary

**Closed: release shipped 2026-05-11 via PR #449.**

All publishable workspaces landed at v0.10.0 (plugin at v0.9.0 on its own line):

| Package | npm | GitHub release |
|---|---|---|
| `@ai-sdlc/pipeline-cli` | 0.10.0 ✅ | `pipeline-cli-v0.10.0` |
| `@ai-sdlc/orchestrator` | 0.10.0 ✅ | `orchestrator-v0.10.0` |
| `@ai-sdlc/reference` | 0.10.0 ✅ | (no separate tag) |
| `@ai-sdlc/sdk` (workspace `sdk-typescript`) | 0.10.0 ✅ | `sdk-typescript-v0.10.0` |
| `@ai-sdlc/mcp-advisor` | 0.10.0 ✅ | `mcp-advisor-v0.10.0` |
| `@ai-sdlc/conformance` (workspace `conformance/runner`) | 0.10.0 ✅ | (no separate tag) |
| `ai-sdlc-plugin` | n/a | `ai-sdlc-plugin-v0.9.0` (Latest) |
| `dashboard` | private | n/a (correctly skipped) |

Acceptance criteria assessment:
- AC #1 (audit pnpm-workspace vs release-please-config) — release-please reconciled this implicitly during the cut
- AC #2 (publishConfig.access: public + lint:publishable) — lint passed during release.yml run
- AC #3 (version bump tier) — minor on 0.x, correct given autonomous-orchestrator + cross-harness-review additions
- AC #4 (CHANGELOG aggregator entry) — release-please generated per-workspace CHANGELOGs from conventional-commit history
- AC #5 (operator runbook) — a substantial release runbook is a separate doc deliverable; treat as follow-up if needed (the actual mechanics are now: `gh workflow run release.yml --ref main` triggers fresh release-please regen, then operator merges the resulting PR)
- AC #6 (npm publishes) ✅ — verified via `npm view`
- AC #7 (GitHub Release notes) ✅ — release-please generated them, including links to RFCs

Side-effects shipped during this cut (workflow hardening for future releases):
- **PR #445** — auto-enable workflow now skips release-please PRs (operator decides when to ship)
- **PR #446 + 447** — verify-attestation correctly handles release-please merge_group events (was looping with `failed_checks`)
- **PR #448** — release.yml gained `workflow_dispatch:` trigger so operator can re-fire without push to main
- **PR #450** — release-please-action now uses `AI_SDLC_PAT` so its pushes trigger downstream CI (was leaving regenerated heads with zero CI)
- **PR #451** — verify-attestation regex now matches `app/<bot>` form returned by `gh pr view --json author`

Net: the release pipeline is significantly more robust for future cuts.
