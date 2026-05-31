---
id: AISDLC-474
title: >-
  Rename /ai-sdlc:review command to /ai-sdlc:review-pr (avoid collision with
  built-in Claude Code /review)
status: Done
assignee: []
created_date: '2026-05-29 16:47'
labels:
  - plugin
  - commands
  - dx
  - bugfix
dependencies: []
priority: high
updated_date: '2026-05-31 00:58'
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
- [x] #1 git mv `ai-sdlc-plugin/commands/review.md` to `ai-sdlc-plugin/commands/review-pr.md` (history preserved)
- [x] #2 Renamed file frontmatter `name:` reads `review-pr`; description, argument-hint, allowed-tools, and the command body unchanged
- [x] #3 `ai-sdlc-plugin/README.md` Slash Commands table references `/ai-sdlc review-pr`, not `/ai-sdlc review`
- [x] #4 Root `README.md` review command row updated if present (skip if absent, do not invent)
- [x] #5 `pnpm lint`, `pnpm format:check`, `pnpm build` pass; `no-bare-paths.test.mjs` passes (it enumerates command files dynamically)
- [x] #6 Zero plugin command names collide with built-in Claude Code commands after this lands
<!-- AC:END -->

## Final Summary

## Summary
Renamed the plugin's `/ai-sdlc:review` slash command to `/ai-sdlc:review-pr` to eliminate the collision with Claude Code's built-in `/review` command. This is the second of two collisions surfaced by the AISDLC-473 conflict audit (the first, `status` → `pipeline-status`, shipped as PR #768). After this lands, zero plugin command names collide with built-ins.

## Changes
- `ai-sdlc-plugin/commands/review.md` → `ai-sdlc-plugin/commands/review-pr.md` (modified): git mv (R099, history preserved); frontmatter `name:` changed `review` → `review-pr`. Body, description, argument-hint, allowed-tools byte-identical.
- `ai-sdlc-plugin/README.md` (modified): Slash Commands table row `/ai-sdlc review` → `/ai-sdlc review-pr`.

## Design decisions
- **Command-metadata-only change**: per the task contract, only the filename, `name:` field, and doc-table reference change. The command body is untouched so behavior is identical under the new name.
- **AC-4 skipped intentionally**: root `README.md` has no review command-table row (only execute/cleanup under canonical-execution-paths), so nothing to update — not invented.
- **Historical design docs left untouched**: spec/RFC/PRD references to the old name describe authoring-time intent; no test or docs-drift linter fails on them.

## Verification
- `pnpm build` — pre-existing typecheck error at `pipeline-cli/src/cli/bin-invocation.test.ts:364` (TS2339), confirmed identical on clean origin/main; this diff is markdown-only (zero TS).
- `pnpm test` — clean (ai-sdlc-plugin node --test suite not in the gated aggregate).
- `pnpm lint` — clean.
- `pnpm format:check` — clean.
- `no-bare-paths.test.mjs` — renamed `review-pr.md` passes; the 4 reported failures are in `import-spec.md`/`rfc-init.md`, confirmed pre-existing on clean origin/main and unrelated to this rename.
- 1 reviewer (code-reviewer, classifier-scoped for docs-only change) approved with zero findings.

## Follow-up
- Pre-existing, unrelated to this task: (1) TS2339 typecheck error at `pipeline-cli/src/cli/bin-invocation.test.ts:364`; (2) `no-bare-paths.test.mjs` failures in `import-spec.md`/`rfc-init.md`. Both reproduce on clean origin/main — candidates for a separate cleanup task.
