---
id: AISDLC-234
title: >-
  Plugin MCP server — add Pattern-C-aware task_create tool (currently only
  task_edit + task_complete route to worktrees)
status: To Do
assignee: []
created_date: '2026-05-07 21:35'
labels:
  - enhancement
  - plugin
  - mcp
  - pattern-c
  - dogfood
dependencies: []
priority: medium
references:
  - ai-sdlc-plugin/mcp-server/
  - CLAUDE.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The plugin's MCP server (`mcp__plugin_ai-sdlc_ai-sdlc__*`) implements Pattern C routing per AISDLC-216 — it reads `<parent>/.worktrees/<id>/.active-task` sentinels (or the `AI_SDLC_ACTIVE_TASK_ID` env) to route tool calls to the correct worktree, NOT the parent's read-only working tree.

Today the plugin exposes:
- `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` — Pattern C routing ✓
- `mcp__plugin_ai-sdlc_ai-sdlc__task_complete` — Pattern C routing ✓

It does NOT expose `task_create`. Operators / agents creating new backlog tasks have two choices:

1. **`mcp__backlog__task_create`** — the upstream MCP tool. Resolves project-root from MCP server startup cwd, which is the parent. Pattern C contract makes the parent's working tree read-only — so MCP would write the file into a directory that gets `git reset --hard origin/main`'d on the next dispatch, losing the work.

2. **Direct `Write` to `<worktree>/backlog/tasks/<id>.md`** — bypasses MCP entirely. Loses any tool-side schema validation or normalization the MCP tool does at create time.

Witnessed multiple times in 2026-05 dogfood: agents creating backlog tasks via direct `Write` because Pattern C blocks `mcp__backlog__task_create`. Operator caught this 2026-05-07 ("are you writing tasks to the backlog without using the mcp tool?").

## Proposed fix

### New tool: `mcp__plugin_ai-sdlc_ai-sdlc__task_create`

Exposed by the plugin's MCP server (`ai-sdlc-plugin/mcp-server/src/`). Same input shape as `mcp__backlog__task_create` (id, title, description, status, priority, labels, dependencies, references, etc.), but:

- Resolves project root via the existing AISDLC-216 routing (env → sentinel → cwd-walk)
- Writes the task file to `<routed-root>/backlog/tasks/<id - title>.md`
- Validates frontmatter against the project's existing backlog-drift gate before writing (early failure surface)
- Returns the created file path so the caller can verify

### Keep `mcp__backlog__task_create` working

The upstream tool still works — for non-Pattern-C projects (no `.worktrees/` directory) or when the operator explicitly wants to write to the parent. Don't break it; just provide the routing-aware variant alongside.

### Documentation update

Update `CLAUDE.md`'s Backlog Workflow section to clarify:
- Use `mcp__plugin_ai-sdlc_ai-sdlc__task_create` for new tasks in Pattern C projects
- Use `mcp__backlog__task_create` for projects without worktree isolation

## Acceptance Criteria

- [ ] #1 New `mcp__plugin_ai-sdlc_ai-sdlc__task_create` tool exposed by `ai-sdlc-plugin/mcp-server`
- [ ] #2 Tool shares Pattern C routing with `task_edit` + `task_complete` — same env precedence, sentinel scan, fallback
- [ ] #3 Tool input schema mirrors `mcp__backlog__task_create` (id, title, description, status, priority, labels, dependencies, references)
- [ ] #4 Returned response includes the resolved file path so callers can verify the worktree routing
- [ ] #5 Frontmatter validation: same drift-gate checks as the existing backlog-drift gate (early failure)
- [ ] #6 Hermetic tests: (a) routes to worktree when sentinel exists, (b) routes to parent when no `.worktrees/` exists (non-Pattern-C projects), (c) refuses with clear error when Pattern C parent has no sentinel and no env override
- [ ] #7 `CLAUDE.md` Backlog Workflow section updated to point at the plugin's create tool for Pattern C projects
- [ ] #8 Plugin's documented tool list (in plugin README or governance skill) includes the new tool

## Composes with

- **AISDLC-216** (Pattern C MCP routing) — extends the same routing primitive to the missing third tool
- **AISDLC-228 / AISDLC-233** (worktree contract concerns) — Pattern C correctness is the umbrella

## References

- `ai-sdlc-plugin/mcp-server/src/` (plugin MCP server source — task_create implementation lives here)
- `CLAUDE.md` (Pattern C section + Backlog Workflow section to update)
- AISDLC-216 (introducing Pattern C routing for the existing plugin tools)
- AISDLC-99 (introducing the project-root resolver the routing builds on)
- Operator observation 2026-05-07: "are you writing tasks to the backlog without using the mcp tool?"
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 mcp__plugin_ai-sdlc_ai-sdlc__task_create tool exposed by plugin MCP server
- [ ] #2 Pattern C routing shared with task_edit + task_complete (env → sentinel → fallback)
- [ ] #3 Input schema mirrors mcp__backlog__task_create
- [ ] #4 Response includes resolved file path for verification
- [ ] #5 Frontmatter validation matches backlog-drift gate
- [ ] #6 Hermetic tests cover: routes-to-worktree, non-Pattern-C-fallback, refusal-without-sentinel
- [ ] #7 CLAUDE.md Backlog Workflow updated to point at plugin's create tool
- [ ] #8 Plugin tool list documents the new tool
<!-- SECTION:ACCEPTANCE:END -->
