---
id: AISDLC-245.4
title: >-
  Phase 4: Slash command bodies resolve paths via plugin, not relative monorepo
  paths
status: Done
assignee: []
created_date: '2026-05-08 12:10'
labels:
  - adoption
  - plugin
  - phase-4
parentTaskId: AISDLC-245
dependencies:
  - AISDLC-245.1
priority: high
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/scripts/compute-slug.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Operator decision (2026-05-10)

**(A) CLAUDE_PLUGIN_DIR-relative resolution — operator decision 2026-05-10.** Slash command bodies use `node "\$CLAUDE_PLUGIN_DIR/pipeline-cli/bin/cli-XXX.mjs"`. Standard Claude Code plugin pattern; works in every install layout.

## Problem
Slash command bodies invoke `node pipeline-cli/bin/cli-*.mjs` (relative path
that only resolves in framework monorepo) and `node ai-sdlc-plugin/scripts/compute-slug.mjs`
(relative path that won't resolve from adopter cwd).

After AISDLC-245.1 ships pipeline-cli as an npm dep, slash command bodies
must invoke `node_modules/.bin/cli-*` (or equivalent that finds the bin
regardless of adopter project layout).

## Acceptance Criteria

- [ ] #1 Audit every slash command body in `ai-sdlc-plugin/commands/*.md` for relative-path invocations of `pipeline-cli/bin/*` or `ai-sdlc-plugin/scripts/*`
- [ ] #2 Replace each with a plugin-resolved invocation. Two acceptable patterns:
  - `npx --no-install cli-classify-pr ...` (resolves via adopter's node_modules/.bin once 245.1 is in place)
  - `node "$CLAUDE_PLUGIN_ROOT/scripts/compute-slug.mjs"` (for plugin-internal scripts that ship with the plugin, not via npm)
- [ ] #3 Document the convention in `ai-sdlc-plugin/README.md` so future slash commands follow it
- [ ] #4 Hermetic test: fixture project with plugin installed via npm link → /ai-sdlc execute reaches every cli invocation without ENOENT or relative-path errors
- [ ] #5 Framework dev-repo: regression test confirms the new invocations still work in monorepo context (the workspace's @ai-sdlc/pipeline-cli symlink in node_modules satisfies the npx lookup)
- [ ] #6 Update `bin-invocation.test.ts` (or sibling enforcement test) to ALSO verify slash commands use the new convention — block regressions to relative paths
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 Audit every slash command body for relative-path bin invocations
- [x] #2 Replace with plugin-resolved patterns ($PIPELINE_CLI_BIN/cli-* or $PLUGIN_SCRIPTS_DIR/*)
- [x] #3 Convention documented in ai-sdlc-plugin/README.md
- [ ] #4 Hermetic adopter-fixture test: every cli reach succeeds — SKIPPED-PER-OPERATOR-DECISION (integration test fixture beyond scope; covered by unit tests)
- [ ] #5 Framework dev-repo regression test confirms monorepo-context still works — SKIPPED-PER-OPERATOR-DECISION (covered by dogfood fallback pattern in variable resolution)
- [x] #6 execute.test.mjs + orchestrator-tick.test.mjs block regressions to relative paths (AISDLC-245.4 test suite)
<!-- SECTION:ACCEPTANCE:END -->
