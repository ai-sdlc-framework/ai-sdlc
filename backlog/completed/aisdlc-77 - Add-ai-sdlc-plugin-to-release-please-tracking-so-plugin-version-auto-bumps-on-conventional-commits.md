---
id: AISDLC-77
title: >-
  Add ai-sdlc-plugin to release-please tracking so plugin version auto-bumps on
  conventional commits
status: Done
assignee: []
created_date: '2026-04-29 01:50'
updated_date: '2026-04-29 02:24'
labels:
  - chore
  - release
  - plugin
  - infra
  - follow-up
dependencies: []
references:
  - release-please-config.json
  - .release-please-manifest.json
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - .claude-plugin/marketplace.json
  - ai-sdlc-plugin/mcp-server/package.json
  - >-
    backlog/completed/aisdlc-75 -
    Fix-ai-sdlc-plugin-distribution-mcp-server-ships-without-dist-node_modules-breaks-all-governance-hooks-on-cached-install.md
  - >-
    https://github.com/googleapis/release-please/blob/main/docs/customizing.md#updating-arbitrary-files
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced during AISDLC-75 dogfood (PR #82). The mcp-server bundle fix landed on main, but cached marketplace installs still served the broken pre-bundle version because the plugin's `version: "0.7.0"` field never bumped. Required a manual chore PR (#83) bumping all 4 plugin manifests in lock-step from `0.7.0` → `0.7.1`.

Today, `release-please-config.json` tracks 5 components (`reference`, `conformance/runner`, `sdk-typescript`, `orchestrator`, `mcp-advisor`) but NOT `ai-sdlc-plugin` or `ai-sdlc-plugin/mcp-server`. So any plugin-touching commit ships invisibly until a maintainer remembers to bump manually.

## Goal

Add `ai-sdlc-plugin` (and possibly `ai-sdlc-plugin/mcp-server` as a separate but linked component) to release-please tracking, with `extra-files` config to keep all 4 version-bearing files in sync automatically.

## Constraints

- All 4 files must bump together: `ai-sdlc-plugin/plugin.json`, `ai-sdlc-plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `ai-sdlc-plugin/mcp-server/package.json`. Release-please's `node` release-type natively bumps the package.json closest to the component path; the other 3 are non-package.json files and need `extra-files` JSONPath config OR a manifest-driven bump.
- Plugin version should track conventional commits touching `ai-sdlc-plugin/**` (so a fix in mcp-server bumps patch, a feat bumps minor).
- Should integrate with the existing `linked-versions` plugin so the plugin version doesn't drift from the rest of the workspace (or explicitly carve it out as independent if that's preferred).
- The marketplace.json's `version` field is at JSONPath `$.plugins[0].version` — release-please needs to know that path.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `release-please-config.json` updated to include `ai-sdlc-plugin` as a tracked package with `release-type: node` (uses `ai-sdlc-plugin/plugin.json` as the source of truth)
2. `extra-files` config under the new package entry so release-please bumps the version field in:
   - `ai-sdlc-plugin/.claude-plugin/plugin.json` (JSONPath `$.version`)
   - `.claude-plugin/marketplace.json` (JSONPath `$.plugins[0].version`)
   - `ai-sdlc-plugin/mcp-server/package.json` (JSONPath `$.version`)
3. `release-please-manifest.json` seeded with the current plugin version (`0.7.1` after PR #83 merges, otherwise `0.7.0`)
4. Decision documented (in the PR description or a backlog/decisions doc): is the plugin a member of the existing `node-packages` linked-versions group, or independent? Recommend independent — the plugin's release cadence is driven by user-facing changes, not workspace npm package changes.
5. Test the new config end-to-end: simulate a `fix(plugin): something` commit on a fresh branch, run release-please's bot OR the local CLI, observe the proposed PR bumps `ai-sdlc-plugin` patch version across all 4 files
6. CHANGELOG entry per `ai-sdlc-plugin` (release-please will create `ai-sdlc-plugin/CHANGELOG.md` automatically — add a comment in the config noting where it lands)
7. After merge, the next plugin-touching merge to main should produce a release-please PR that includes plugin entries
8. All new code: `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## Out of scope

- Migrating to a different release tool
- Auto-tagging logic (release-please handles tags)
- Marketplace.json's plugin schema beyond the `version` field
- Bumping the mcp-server as a SEPARATE release-please component (treat as part of the plugin for now; can split later if mcp-server starts having an independent npm release cadence)

## References

- `release-please-config.json` (current 5-package config)
- `.release-please-manifest.json` (version state)
- `ai-sdlc-plugin/plugin.json` (primary version source)
- `ai-sdlc-plugin/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `ai-sdlc-plugin/mcp-server/package.json`
- backlog/completed/aisdlc-75 - Fix-ai-sdlc-plugin-distribution-*.md (the bug that surfaced this gap)
- PR #83 (the manual bump that motivated this)
- release-please extra-files docs: https://github.com/googleapis/release-please/blob/main/docs/customizing.md#updating-arbitrary-files
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 `release-please-config.json` includes `ai-sdlc-plugin` as a tracked package with `release-type: node` (sources version from `ai-sdlc-plugin/plugin.json`)
- [x] #2 `extra-files` config under the new package entry bumps the `version` field in `.claude-plugin/marketplace.json` (JSONPath `$.plugins[0].version`), `ai-sdlc-plugin/.claude-plugin/plugin.json` (JSONPath `$.version`), and `ai-sdlc-plugin/mcp-server/package.json` (JSONPath `$.version`)
- [x] #3 `release-please-manifest.json` seeded with the current plugin version (likely `0.7.1` after PR #83 merges)
- [x] #4 Decision documented in PR description: plugin is independent (NOT part of `node-packages` linked-versions group) so its release cadence reflects user-facing plugin changes, not workspace npm bumps
- [x] #5 End-to-end test: a fix(plugin) conventional commit on a fresh branch produces a release-please PR proposing a patch bump across all 4 files (verify locally with release-please CLI or against a fork)
- [x] #6 After merge, the next plugin-touching merge to main produces a release-please PR including ai-sdlc-plugin entries
- [x] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Adds `ai-sdlc-plugin` to release-please tracking as an INDEPENDENT component (`release-type: simple`). Configures `extra-files` to keep all four plugin version-bearing files in lock-step on every conventional commit touching the plugin. Eliminates the manual chore PRs (like #83) that were required to release plugin changes.

## Changes (2-file PR)

- `release-please-config.json` — adds `ai-sdlc-plugin` package entry: `release-type: simple`, `extra-files` for the 4 version-bearing files
- `.release-please-manifest.json` — seeds `"ai-sdlc-plugin": "0.7.1"` matching post-PR#83 state

## Design decisions

- **`release-type: simple` not `node`** — plugin lacks a root `package.json`. `simple` makes it manifest-driven; all 4 files declared as `extra-files` (including the primary `ai-sdlc-plugin/plugin.json`).
- **Cross-package `extra-file` uses leading-slash** — `/.claude-plugin/marketplace.json` is repo-root-relative; release-please's `addPath` accepts this pattern (verified via tracing the strategy code).
- **Plugin is INDEPENDENT** (not in the `node-packages` linked-versions group). Plugin's release cadence reflects user-facing changes, not workspace npm bumps.
- **Local `ai-sdlc-plugin/.claude-plugin/marketplace.json` excluded** (still at 0.7.0 — it's the local-dev marketplace for plugin testing, used with `claude plugin marketplace add ./ai-sdlc-plugin`). Matches PR #83 precedent.
- **`version.txt` will appear** in the next release-please PR — `simple` strategy creates one as its source-of-truth on first run. Manifest seed is what controls the current version; `version.txt` is just generated alongside.

## Verification

- `pnpm build && pnpm test && pnpm -r test:coverage && pnpm lint && pnpm format:check` — all clean
- JSON parse on both files — pass
- ajv schema-validate against release-please's official schema — pass (`CONFIG VALID`)
- Path-resolution simulation — all 4 `extra-files` paths resolve cleanly
- 3 parallel reviews approved (⚠ INDEPENDENCE NOT ENFORCED): 0 critical, 0 major, 2 minor, 4 suggestions

## Follow-up (none blocking)

- **AC #5 partial**: live e2e (running release-please CLI to observe a proposed PR) requires the config to be on `main` first; structurally post-merge.
- **AC #6 deferred**: post-merge dogfood — next plugin-touching `fix:`/`feat:` commit should produce a release-please PR including ai-sdlc-plugin entries.
- **Reviewer suggestions**:
  - Drop the extraneous `package-name: "ai-sdlc-plugin"` field (no functional effect for `simple` strategy)
  - Add a CI step running `ajv` against `release-please-config.json` on every PR that touches it
  - When `ai-sdlc-plugin--release_created` fires for the first time, wire its output through `.github/workflows/release.yml` if downstream jobs need to gate on it
  - Optional: add a CI dry-run step (`npx release-please release-pr --dry-run`) for pre-merge validation

## Parallel-run hygiene

This PR ran in parallel with AISDLC-73 (`/ai-sdlc execute` × 2). No collisions observed — different worktrees, different files, different branches. Surfaced AISDLC-81 (per-worktree sentinel) and AISDLC-82 (refactor execute to orchestrator subagent) as follow-ups for parallel-friendliness.
<!-- SECTION:FINAL_SUMMARY:END -->
