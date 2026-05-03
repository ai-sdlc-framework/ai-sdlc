---
id: AISDLC-99
title: >-
  mcp__plugin_ai-sdlc_ai-sdlc__task_edit/complete hardcoded to wrong backlog
  root
status: Done
assignee: []
created_date: '2026-04-30 22:14'
updated_date: '2026-04-30 23:13'
labels:
  - plugin
  - bug
  - mcp-server
  - backlog-tools
dependencies: []
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-83 -
      Wire-ai-sdlc-execute-and-other-commands-to-use-mcp__ai-sdlc-plugin__task_edit-task_complete-instead-of-upstream.md
      was modified after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Trigger:** AISDLC-69.2's orchestrator run discovered that `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` and `mcp__plugin_ai-sdlc_ai-sdlc__task_complete` are hardcoded to operate on `/Users/dominique/.claude/plugins/data/ai-sdlc-ai-sdlc-local/backlog/{tasks,completed}/` — a path that doesn't exist for this (or any normal) project. The orchestrator fell back to direct file editing for the status flip + revert, which worked because AISDLC-69.2 has no `permittedExternalPaths` declarations to govern.

The MCP server's backlog tools should respect the actual project root (`AI_SDLC_PROJECT_ROOT` env var, set by the plugin to `${CLAUDE_PLUGIN_DATA}` per `plugin.json`'s `mcpServers.ai-sdlc.env`) rather than baking in a path that points at the plugin's own data directory.

## Root cause investigation

The plugin's `plugin.json` declares:

```json
"mcpServers": {
  "ai-sdlc": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/bin.js"],
    "env": {
      "AI_SDLC_PROJECT_ROOT": "${CLAUDE_PLUGIN_DATA}"
    }
  }
}
```

`${CLAUDE_PLUGIN_DATA}` resolves to `~/.claude/plugins/data/<source>-<plugin-name>/` — that's the plugin's WRITE-AVAILABLE data directory, NOT the project root the user is working in. So the env var is correctly set per the plugin spec, but the value is wrong for this use case.

**The fix needs to be**: the MCP server needs to resolve the project root from the spawning Claude Code session's cwd (or some other dynamic source), not from a baked-in env var. Or the plugin needs to NOT set `AI_SDLC_PROJECT_ROOT` and let the MCP server discover it.

## What this affects

- Any task using the plugin's task_edit/task_complete tools to update status/move files (which is supposed to be the canonical path post-AISDLC-90)
- The orchestrator falling back to direct file edit works for tasks WITHOUT `permittedExternalPaths`. Tasks WITH `permittedExternalPaths` are at risk because:
  - The plugin tool (broken root) can't see them
  - The upstream `mcp__backlog__task_edit` strips unknown frontmatter keys per a previously-observed bug, breaking `permittedExternalPaths`
- So tasks declaring `permittedExternalPaths` are currently in a no-good-tool state.

## Mitigations

### Option A — Fix the plugin MCP server's root resolution

Update `ai-sdlc-plugin/mcp-server/src/` (the MCP server source) to:
- Read `AI_SDLC_PROJECT_ROOT` env var first (current behavior)
- If unset OR if the resolved path doesn't contain `backlog/`, fall back to walking up from `process.cwd()` looking for the `backlog/` directory
- Document the env var as overrideable per-project

### Option B — Pass project root from the spawning context

Have the slash command (or operator) explicitly pass the project root as an MCP tool argument: `task_edit(id: '...', projectRoot: '/path/to/project', ...)`. More verbose but explicit.

### Option C — Don't set `AI_SDLC_PROJECT_ROOT` in plugin.json

Let the MCP server use its own discovery logic (likely walking up from cwd). Simpler. Avoids the wrong-default problem.

### Recommendation: Option A (env-var with cwd fallback)

Preserves backward compatibility (plugins that explicitly set the var still work) but adds the right discovery behavior when the env var is wrong or absent.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Update MCP server in `ai-sdlc-plugin/mcp-server/src/` to: read `AI_SDLC_PROJECT_ROOT` first; if unset or path doesn't contain `backlog/` directory, walk up from `process.cwd()` looking for `backlog/` dir
2. Update the plugin's `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` and `task_complete` tools to use the resolved project root
3. Add unit tests: env-var-set-correctly path, env-var-set-wrong + cwd-discovery path, env-var-unset + cwd-discovery path, no-backlog-found error path
4. End-to-end manual test: open a Claude Code session in this project, call `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` with a real task ID, confirm it actually edits the project's `backlog/tasks/<id>.md`
5. Bump plugin version (release-please picks up via fix: prefix)
6. All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
7. Document the env-var-with-cwd-fallback discovery in CLAUDE.md or the plugin README

## References

- `ai-sdlc-plugin/.claude-plugin/plugin.json` — declares `AI_SDLC_PROJECT_ROOT: ${CLAUDE_PLUGIN_DATA}`
- `ai-sdlc-plugin/mcp-server/src/` — MCP server source (the file to fix)
- `ai-sdlc-plugin/mcp-server/dist/bin.js` — bundled output (auto-regenerated on build)
- AISDLC-69.2 orchestrator's secondary finding (this session) — empirical discovery of the bug
- AISDLC-83 — `permittedExternalPaths` mechanism (the use case that's currently broken)
- AISDLC-98 — sibling task reverting AISDLC-82; this task addresses the second finding from the same parallel test
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Update MCP server source to read `AI_SDLC_PROJECT_ROOT` first; fall back to walking up from `process.cwd()` for `backlog/` directory if unset or wrong
- [x] #2 Update plugin's `task_edit` and `task_complete` tools to use the resolved project root from the new discovery logic
- [x] #3 Add unit tests: env-var-correct, env-var-wrong + cwd-fallback, env-var-unset + cwd-fallback, no-backlog-found error
- [x] #4 End-to-end manual test: open Claude Code in this project, call `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` with a real task ID, confirm it edits the project's actual `backlog/tasks/<id>.md`
- [x] #5 Document env-var-with-cwd-fallback discovery in CLAUDE.md or plugin README
- [x] #6 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Fixed the plugin MCP server's `task_edit` and `task_complete` tools that were hardcoded to operate against `${CLAUDE_PLUGIN_DATA}` (a path that resolves to `~/.claude/plugins/data/<source>-<plugin>/` and doesn't exist for normal projects). New `resolve-project-root.ts` helper provides a discovery chain: `AI_SDLC_PROJECT_ROOT` env var → `CLAUDE_PROJECT_DIR` env var → walk up from `process.cwd()` looking for nearest `backlog/` ancestor → throw canonical error. Both tools now resolve the project root per-invocation via the new helper.

This is the prerequisite for AISDLC-100.3 (Phase 3 of RFC-0012, MCP tool wrapping for the new pipeline-cli architecture).

## Changes

- `ai-sdlc-plugin/mcp-server/src/lib/resolve-project-root.ts` — NEW helper module implementing the discovery chain
- `ai-sdlc-plugin/mcp-server/src/lib/resolve-project-root.test.ts` — NEW 9 unit tests covering all 4 AC paths + 5 edge cases (CLAUDE_PROJECT_DIR precedence, ghost path, file-not-dir, nested projects, error message stability)
- `ai-sdlc-plugin/mcp-server/src/server.ts` — wires the new helper at boot
- `ai-sdlc-plugin/mcp-server/src/tools/task-edit.ts` — calls `pickProjectRoot(deps.projectDir)` per-invocation
- `ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts` — same change
- `ai-sdlc-plugin/mcp-server/dist/bin.js` — regenerated bundle (verified by security reviewer to faithfully match source)
- `CLAUDE.md` — new "Plugin MCP server — project-root discovery (AISDLC-99)" section documenting the discovery order

## Design decisions

- **Per-invocation resolution**: tools call `pickProjectRoot(deps.projectDir)` at every call (not just at server boot) so cwd changes between calls are honored.
- **Env-var validation**: env-var-resolved paths must contain a `backlog/` subdirectory to be honored. Prevents redirection to `/etc/`, `/tmp/`, etc. unless those literally have `backlog/`.
- **Walk-up bounded**: standard `dirname(p) === p` filesystem-root termination.
- **Cross-project discovery is operator-chosen**: if operator runs Claude Code from inside an unrelated project, the walk-up finds THAT project's `backlog/`. Documented in test `finds the closest backlog/ ancestor when nested projects exist`. Per security review, this is acceptable under the trusted-operator threat model.

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — all clean
- `node --test 'ai-sdlc-plugin/**/*.test.mjs'` — 165 Node-built-in tests pass
- mcp-server: 79/79 vitest pass; full workspace counts: orchestrator 2854/2854, reference 1218 (3 skipped), dashboard 126/126, dogfood 292/292, conformance 23/23, mcp-advisor 131/131, sdk-typescript 15/15
- 3 parallel reviews APPROVED (0 critical, 0 major, 5 minor, 1 suggestion across all reviewers); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable)
- Bundle parity: security reviewer manually verified `dist/bin.js` lines 21330-21610 match `src/lib/resolve-project-root.ts` and `src/tools/task-edit.ts` (modulo esbuild's automatic `resolve` → `resolve2` rename to avoid colliding with `node:path`'s `resolve` import — automatic and benign)

## Follow-up

- **Code reviewer minor (per-call vs boot-time short-circuit)**: `pickProjectRoot()` short-circuits with the boot-time `deps.projectDir` if it's valid. Tests cover this; the comment explains it's for test-injection support. CLAUDE.md wording could be tightened in a future polish PR.
- **Code reviewer minor (weaker local `hasBacklogDir`)**: the version in `task-edit.ts` checks `existsSync` only, while `resolve-project-root.ts`'s checks `statSync().isDirectory()`. Consider exporting the robust version and reusing.
- **Test reviewer minor (no direct `pickProjectRoot` wrapper test, no automated AC #4)**: the underlying `resolveProjectRoot()` is well-tested, but the wrapper's fallback branches (resolveProjectRoot call when injected dir lacks backlog/, error-result when resolution throws) aren't directly exercised. Could add a single integration test in a future polish PR.
- **Code reviewer suggestion (symlink test)**: existing tests happen to canonicalise correctly via `resolve()`, but a dedicated symlink fixture would document intent. Future polish.
- **Code reviewer minor (inline error result type)**: `pickProjectRoot`'s return type uses inline union. A named `ToolErrorResult` type would be cleaner. Future polish.

These are all genuine quality improvements, none blocking. After this PR merges, AISDLC-100.3 (Phase 3 of RFC-0012, MCP tool wrapping) can proceed.
<!-- SECTION:FINAL_SUMMARY:END -->
