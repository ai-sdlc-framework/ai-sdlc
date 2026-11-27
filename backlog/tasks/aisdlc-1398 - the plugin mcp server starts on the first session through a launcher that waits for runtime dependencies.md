---
id: AISDLC-1398
title: 'The plugin MCP server starts on the first session through a launcher that waits for runtime dependencies'
status: In Progress
assignee: []
created_date: '2026-11-23'
labels:
  - bug
  - plugin
  - mcp
dependencies: []
references:
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
priority: medium
---

## Description

**Gap.** `plugin.json:208-216` starts the MCP server as `node ${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js`. On a fresh install those modules do not exist until the SessionStart hook runs `install-runtime-deps.sh`, and Claude Code starts the MCP server in parallel with the hook. The start fails, Claude Code caches the failure, and the tools are missing until the operator deletes `~/.claude/mcp-needs-auth-cache.json` and restarts. AISDLC-1370 only added a recovery message (`session-start.js:539-552`). Reported in GitHub #2754, item 4.

**Ruling.** Operator, 2026-11-23, via the decision rubric (planner session): a launcher script, like `npx -y`. Rejected: editing Claude Code's cache file (undocumented internal state); bundling the server into one file is the later improvement if the launcher's first start runs close to the MCP start timeout.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the tools must be present on the first session with no manual step. 2. Deleted: the recovery message, once the launcher makes it unnecessary. 3. Simplified: one launcher, no change to the hook's install logic. 4. Accelerated: the launcher waits on the hook's install instead of running a second install. 5. Automated: tests below.

- Add `ai-sdlc-plugin/scripts/mcp-launch.mjs` and point `plugin.json` `mcpServers.ai-sdlc` at it. It starts `bin.js` at once when present. Otherwise it waits for the hook's install (the hook's lock or marker file; if no install is running, it runs `install-runtime-deps.sh` itself under the same lock), up to a bound below Claude Code's MCP start timeout, then starts the server in-process so stdio stays attached. On timeout it exits non-zero with a one-line reason on stderr.
- Measure the first start on a fresh install and record it in the PR. If it is within 20% of the timeout, say so in the PR so bundling can be filed.
- Remove the recovery message from `session-start.js` once the launcher covers the case.

## Acceptance Criteria

- [ ] #1 A test: with `bin.js` present, the launcher starts the server without waiting.
- [ ] #2 A test: with the install in progress (lock held), the launcher waits and starts the server when the install completes.
- [ ] #3 A test: with no install running and modules missing, the launcher runs the install under the lock, then starts the server.
- [ ] #4 A test: past the bound, the launcher exits non-zero with a reason on stderr.
- [ ] #5 Manual check in the PR: a fresh install shows the ai-sdlc MCP tools on the first session, with the first-start time measured.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
