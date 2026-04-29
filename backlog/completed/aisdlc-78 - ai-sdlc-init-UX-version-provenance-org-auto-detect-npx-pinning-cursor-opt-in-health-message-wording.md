---
id: AISDLC-78
title: >-
  ai-sdlc init UX: version provenance, org auto-detect, npx pinning, cursor
  opt-in, health-message wording
status: Done
assignee: []
created_date: '2026-04-29 01:53'
updated_date: '2026-04-29 06:24'
labels:
  - bug
  - ux
  - init
  - user-feedback
  - alex
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

User feedback from neuralcartographer (akillies) fresh install on 2026-04-28. Five distinct papercuts in `ai-sdlc init` — none destructive (init is safe), all UX or provenance.

## The five issues

### 1. Version mismatch + provenance
- `ai-sdlc --version` (global CLI at `~/.nvm/.../bin/ai-sdlc`) reports `0.1.0`
- `npm view @AI-SDLC/orchestrator version` returns `0.6.0`
- Five minors apart. **Which is canonical?** Either the global is stale OR the published packages have diverged from the CLI binary's lineage. User can't tell.
- **Fix**: print BOTH the CLI binary version AND the orchestrator package version on every `init` run AND on `ai-sdlc --version`. Surface drift loudly.

### 2. `pipeline.yaml` hardcodes `org: your-org`
- `init` doesn't parse `git remote get-url origin` to extract org/repo
- New user sees `your-org` literal, has to know it needs editing
- **Fix**: at init, run `git remote get-url origin`, parse `org/repo` from the URL (handles both ssh + https forms), substitute into the pipeline.yaml template. Fall back to `your-org` only if no remote exists.

### 4. `.mcp.json` uses `npx -y` (no version pin)
- Every cold-start downloads latest `@AI-SDLC/mcp-advisor`
- Reproducibility risk: a published mcp-advisor regression silently affects every running session
- **Fix**: pin to the orchestrator version that init shipped with (e.g. `@AI-SDLC/mcp-advisor@0.7.0`). Provide an opt-out comment in the .mcp.json explaining how to track latest if desired.

### 5. `.cursor/mcp.json` written without opt-in
- Init writes Cursor MCP config even when Cursor isn't installed
- **Fix**: gate on `which cursor` (or check for `~/.cursor/` / `~/Library/Application Support/Cursor/`). If Cursor isn't present, skip writing `.cursor/mcp.json` AND log a `(cursor not detected — skipping .cursor/mcp.json; rerun with --cursor to force)` line.

### 6. `ai-sdlc health` "State Store: not configured" wording
- Reads like a config error on first run; user assumes init failed
- Reality: state DB initializes lazily on first orchestrator run
- **Fix**: change wording to `State Store: deferred until first pipeline run` or `State Store: lazy (initializes on demand)`.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `ai-sdlc --version` (and `init` startup banner) prints CLI binary version + orchestrator package version + plugin version, in a 3-line block. Discrepancy between them gets a `⚠ versions out of sync — run npm i -g @AI-SDLC/orchestrator@latest` warning.
2. `init` parses `git remote get-url origin` for `org/repo`, substitutes into `pipeline.yaml`. Tested with both `git@github.com:foo/bar.git` and `https://github.com/foo/bar(.git)?` URL forms. Falls back to `your-org`/`your-repo` only when no remote.
3. `.mcp.json` template pins mcp-advisor to the version that shipped with the running CLI binary (no `npx -y` floating). Comment in the file explains how to opt into latest.
4. `init` skips `.cursor/mcp.json` when Cursor isn't detected on the system. Log line explains the skip + the override flag (`--cursor`).
5. `ai-sdlc health` rewords "State Store: not configured" to "State Store: deferred (initializes on first pipeline run)" or equivalent. Optionally add a `(--init-state)` flag to eagerly create the state DB for users who want a definitive "ready" signal.
6. Regression tests for each: parsing org URL forms, version-drift warning, cursor detection logic, npx-pin substitution.
7. CHANGELOG entry.
8. All new code: 80%+ patch coverage, build/test/lint/format clean.

## Out of scope

- Issue #3 (agent-role tools list) — separate task, requires a design decision
- Issue #7 (conflict check vs existing .claude/) — only matters once PreToolUse hook ships from the plugin; track separately
- Complexity detector accuracy — separate task

## References

- User report (Alex Kline / neuralcartographer / akillies, 2026-04-28)
- `cli/src/init.ts` (or wherever init lives)
- `templates/.mcp.json`
- `templates/pipeline.yaml`
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 `ai-sdlc --version` and `init` startup print CLI binary version + orchestrator package version + plugin version (3-line block); a discrepancy emits `⚠ versions out of sync` warning with the upgrade command
- [x] #2 `init` parses `git remote get-url origin` for org/repo and substitutes into `pipeline.yaml`. Handles `git@github.com:foo/bar.git` and `https://github.com/foo/bar(.git)?`. Falls back to `your-org`/`your-repo` only when no remote exists.
- [x] #3 `.mcp.json` template pins mcp-advisor to the version that shipped with the running CLI binary (no `npx -y` floating). In-file comment documents the opt-in-to-latest path.
- [x] #4 `init` skips writing `.cursor/mcp.json` when Cursor isn't detected; log line explains the skip and the `--cursor` override flag.
- [x] #5 `ai-sdlc health` rewords `State Store: not configured` to `State Store: deferred (initializes on first pipeline run)` or equivalent; optional `--init-state` flag eagerly creates the state DB for users who want a definitive ready signal.
- [x] #6 Regression tests cover: each git remote URL form, version-drift warning emission, cursor-detection branches, npx-pin substitution.
- [x] #7 CHANGELOG entry under the appropriate package(s)
- [x] #8 All new code: 80%+ patch coverage; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- [x] #9 When a documented CLI subcommand isn't found, the error message detects a version mismatch and points at the upgrade command (e.g., `unknown command 'detect-patterns' — your CLI is 0.1.0 but this command was added in 0.5.0; run npm i -g @AI-SDLC/orchestrator@latest`). Surface from issue #9a in the user report.
- [x] #10 `ai-sdlc agents` reads `agent-role.yaml` and shows declared-but-not-yet-executed agents alongside the runtime roster. Either default behavior OR opt-in via `--include-declared` flag (decision documented). Eliminates the 'No agents registered' confusion immediately after `init`. Surfaces from issue #10 in the user report.
- [x] #11 CONTRIBUTING-style docs note added: canonical answer to 'should co-developers use the published version or a local checkout?' (link to dev-setup workflow for plugin contributors). Surfaces from issue #9b.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Fixed 11 fresh-install papercuts in `ai-sdlc init` from Alex Kline's onboarding feedback. New `versions.ts` module handles 3-line provenance block (CLI/orchestrator/plugin) with drift warning. New `git-remote.ts` parses `git remote get-url origin` and substitutes `org/repo` into `pipeline.yaml`. `.mcp.json` now pins `@ai-sdlc/mcp-advisor` to the running CLI version with an opt-out comment. `.cursor/mcp.json` only writes when Cursor is detected on the system. `ai-sdlc health` rewords the "State Store" line to make lazy initialization clear, plus adds `--init-state` for users who want eager initialization. `ai-sdlc agents` now reads `agent-role.yaml` and surfaces declared-but-not-yet-executed agents. Unknown-subcommand errors now hint at version drift. CONTRIBUTING.md gained a "published vs local checkout" decision tree.

Round 2 fixed a major bug found in round 1 review: the custom `option:version` listener was shadowed by commander 12's built-in handler, so `ai-sdlc --version` would have printed only the bare version string. Fixed by switching to `prependListener` + `_exit(0)` short-circuit, plus added integration tests at the commander-pipeline level that catch this bug class.

## Changes
- `orchestrator/src/cli/versions.ts` (new): 3-line provenance + drift detection + upgrade-hint helper
- `orchestrator/src/cli/versions.test.ts` (new): 9 unit tests
- `orchestrator/src/cli/commands/git-remote.ts` (new): URL parser (ssh/https/scp/garbage) + `applyRemoteToPipelineYaml` substitution
- `orchestrator/src/cli/commands/git-remote.test.ts` (new): 12 unit tests
- `orchestrator/src/cli/commands/init.ts` (modified): integrate git-remote substitution into pipeline.yaml template
- `orchestrator/src/cli/commands/mcp-setup.ts` (modified): pin mcp-advisor to running CLI version, top-level `_aiSdlcComment`, opt-in cursor detection (`--cursor`, project `.cursor/`, or `~/.cursor/`)
- `orchestrator/src/cli/commands/mcp-setup.test.ts` (modified): 4 new tests for pin + cursor branches
- `orchestrator/src/cli/commands/health.ts` (modified): "deferred (initializes on first pipeline run)" wording + `--init-state` flag
- `orchestrator/src/cli/commands/agents.ts` (modified): `loadDeclaredAgents` reads agent-role.yaml; surface declared-but-not-executed
- `orchestrator/src/cli/formatters/table.ts` (modified): "(declared, not yet executed)" row marker
- `orchestrator/src/cli/index.ts` (modified): `buildProgram()` factory + isMainEntry guard; `prependListener('option:version', ...)` to bypass commander shadowing; `command:*` listener for unknown-subcommand hint
- `orchestrator/src/cli/index.test.ts` (new — round 2): 4 integration tests exercising real commander pipeline (--version long+short, unknown-subcommand drift+no-drift)
- `CONTRIBUTING.md`: published-vs-local-checkout section
- `orchestrator/CHANGELOG.md`: entry

## Design decisions
- **`prependListener` over disabling commander's `.version()` entirely**: keeps commander's metadata wiring intact, just inserts the custom handler ahead of commander's default. Cleaner than reimplementing the option from scratch.
- **`_aiSdlcComment` at top level (not per-server)**: more standard JSON shape; some MCP clients validate per-server entries strictly. Top-level keeps the comment discoverable without polluting consumed payloads.
- **Cursor opt-in cascade**: explicit `--cursor` flag → project-local `.cursor/` → `~/.cursor/` (or `~/Library/Application Support/Cursor/`). Linux `XDG_CONFIG_HOME` deferred (suggestion-level, can layer in later).
- **`cli` and `orchestrator` versions intentionally identical for now**: both come from the same package.json. Documented in versions.ts comments as preserved-for-future-split (planned CLI veneer separation). Not dropped from the formatter to avoid churn when the split happens.

## Verification
- `pnpm build` — clean
- `pnpm test` — 2779/2779 orchestrator + all sibling packages green
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED after iteration (round 1: code REJECTED with major; round 2: all 3 APPROVED with 0 critical/major/minor + 4 suggestions)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- Reviewer suggestions (4 total, all deferrable): symmetric no-drift `--version` test, exit-code assertion on no-drift unknown-subcommand test, sentinel return from `findOrchestratorPackageJson`, minor doc-style tweaks
- Linux `XDG_CONFIG_HOME/Cursor` detection (Cursor-opt-in suggestion from round 1)
- Coverage gaps for `loadDeclaredAgents`, `--init-state` flag path, and table-formatter strings (round 1 minor — deferred)
- Unit test for `agents.ts` `loadDeclaredAgents` helper (round 1 minor — deferred)
<!-- SECTION:FINAL_SUMMARY:END -->
