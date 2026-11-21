---
id: AISDLC-1370
title: 'First plugin session starts the MCP server and execute shell blocks run on macOS bash 3.2'
status: To Do
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - plugin
  - install
dependencies: []
references:
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/execute.test.mjs
  - ai-sdlc-plugin/README.md
priority: medium
---

## Description

**Gap.** On a fresh install the MCP server can fail on the first session and stay skipped, and on macOS the first two shell blocks of `execute.md` are refused by Claude Code under `/bin/bash` 3.2. Source: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2754 (items 4 and 5).

**Facts read in code** (main at 687e0d596).

- Item 4. `ai-sdlc-plugin/.claude-plugin/plugin.json:208-213` declares the `ai-sdlc` MCP server as `node ${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js`. `hooks/session-start.js:62-72` says the SessionStart hook installs runtime dependencies before Claude Code starts the MCP server, and `:179-188` runs `scripts/install-runtime-deps.sh` synchronously (120 s limit). Claude Code can start the MCP server in parallel with the hook; the repo has no code that retries it or clears Claude Code's `mcp-needs-auth-cache.json` (grep of `ai-sdlc-plugin` and `docs` for `needs-auth` finds nothing).
- Item 5. `ai-sdlc-plugin/commands/execute.md:20-88` holds the shell blocks: the plugin-root preamble and the CLI resolution block (`:76-88`) use `${VAR:-}` forms and a `$( ... )` with nested quoting. `resolve-pipeline-cli.sh` already exists, but the block that chooses `PIPELINE_CLI_BIN` stays inline in the command. `CLAUDE_CODE_SHELL` appears nowhere in the repo (grep over all non-`node_modules` files).

**Observed** (from the issue, not reproduced here; not traced inside Claude Code). First session: `Cannot find module '.../dist/bin.js'`; the next three sessions reported the server `failed` with no MCP log until `~/.claude/mcp-needs-auth-cache.json` was deleted. On macOS bash 3.2.57 Claude Code refused the blocks with exit 126, and the model rewrote them and once picked the npm `pipeline-cli` 0.42.0 instead of `PIPELINE_CLI_BIN`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: for item 4 the plugin cannot change Claude Code's skip, so the requirement is that the hook never loses the race, or says plainly what to do. For item 5 the requirement is that no inline block depends on the shell version. 2. Deleted: the inline CLI resolution in `execute.md`. 3. Simplified or optimised: one script call per block, run through `bash`/`node` explicitly, so the login shell is irrelevant. 4. Accelerated: no hand rewrite by the model. 5. Automated: a test runs each block's script under a bash 3.2 compatible parse check.

- Item 5: move the preamble and the resolution into scripts in `ai-sdlc-plugin/scripts/` called in one line from `execute.md`, written for bash 3.2 (no `${var,,}`, no associative arrays). Add a short install note to `ai-sdlc-plugin/README.md` naming `CLAUDE_CODE_SHELL` as the fallback for any other command block.
- Item 4: make the SessionStart hook, when it had to install, print one line naming the cache file and the restart step, and make `session-start.js` remove its own stale `plugin:ai-sdlc:ai-sdlc` entry only if the design choice below allows it.

Out of scope: changing Claude Code, and the `PIPELINE_CLI_BIN` precedence rules.

## Open questions

**May the plugin edit Claude Code's `~/.claude/mcp-needs-auth-cache.json`?** It is outside the repository and the project, and removing an entry is an action on the operator's global state. This is not an RFC question.

- Option A: print the manual step only (delete the entry, restart). Safe, no write outside the plugin.
- Option B: the hook deletes only the entry for this plugin's server when it ran the install in this session. Fixes it without a step, but writes a file Claude Code owns.
- Option C: declare the MCP server lazily (a launcher script that waits for the dependencies, then starts the server) so the first start does not fail.

Interim value the developer uses: option A. Recommendation: option C, because it removes the race instead of repairing its effect; it needs a check that a launcher keeps the server's stdio protocol intact.

## Acceptance Criteria

- [ ] #1 `execute.md` blocks each call a script from `ai-sdlc-plugin/scripts/` in one line, and `execute.test.mjs` shows no block uses a construct that bash 3.2 rejects (checked with the repo's bash version where available, or a static pattern check).
- [ ] #2 A test shows the CLI resolution script returns `PIPELINE_CLI_BIN` when set, and the resolved path otherwise, with the same results as the inline block it replaces.
- [ ] #3 `ai-sdlc-plugin/README.md` tells macOS users about `CLAUDE_CODE_SHELL`, and a doc check finds the sentence.
- [ ] #4 When the hook installed dependencies in this session, its banner names the MCP cache file and the one step to recover (interim option A); a test checks the text, and checks that nothing is written outside the plugin directory.
- [ ] #5 The pull request body states the choice made for the open question and that the Claude Code skip was not traced.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
