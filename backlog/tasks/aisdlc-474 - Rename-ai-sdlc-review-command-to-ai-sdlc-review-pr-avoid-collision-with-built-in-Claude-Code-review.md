---
id: AISDLC-474
title: >-
  Rename /ai-sdlc:review command to /ai-sdlc:review-pr (avoid collision with
  built-in Claude Code /review)
status: To Do
assignee: []
created_date: '2026-05-29 16:47'
labels:
  - plugin
  - commands
  - dx
  - bugfix
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Second of the two built-in-command collisions surfaced by the AISDLC-473 conflict audit. The plugin's `review` slash command collides with Claude Code's built-in `/review`; typing `/review` shadows the built-in. Rename the plugin command to `review-pr` so both coexist. (Operator decision 2026-05-29: rename both `status` and `review`; `status` to `pipeline-status` shipped as PR #768 / AISDLC-473, `review` to `review-pr` is this task.)

The command body is unchanged — only the `name:` frontmatter field, the filename, and doc-table references change.

Files to change:
1. git mv `ai-sdlc-plugin/commands/review.md` to `ai-sdlc-plugin/commands/review-pr.md`
2. In that file frontmatter set `name:` to `review-pr` (leave description/argument-hint/allowed-tools and the body unchanged)
3. `ai-sdlc-plugin/README.md` Slash Commands table row: change `/ai-sdlc review` to `/ai-sdlc review-pr`
4. Root `README.md` command table if it has a review row (skip if absent)

Do NOT modify spec/RFC/PRD historical design docs that mention the old command name (they describe authoring-time intent). Fix a reference only if a test or the docs-drift linter actually fails on it.

Conflict audit (from AISDLC-473): of the 18 plugin command names exactly two collided with built-ins, status and review; the other 16 are unique. After this task lands, zero collisions remain.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 git mv `ai-sdlc-plugin/commands/review.md` to `ai-sdlc-plugin/commands/review-pr.md` (history preserved)
- [ ] #2 Renamed file frontmatter `name:` reads `review-pr`; description, argument-hint, allowed-tools, and the command body unchanged
- [ ] #3 `ai-sdlc-plugin/README.md` Slash Commands table references `/ai-sdlc review-pr`, not `/ai-sdlc review`
- [ ] #4 Root `README.md` review command row updated if present (skip if absent, do not invent)
- [ ] #5 `pnpm lint`, `pnpm format:check`, `pnpm build` pass; `no-bare-paths.test.mjs` passes (it enumerates command files dynamically)
- [ ] #6 Zero plugin command names collide with built-in Claude Code commands after this lands
<!-- AC:END -->
