---
id: AISDLC-1180
title: 'MCP advisor setup page with per-client snippets, and a Codex entry in mcp-setup'
status: In Progress
assignee: []
created_date: '2026-11-04'
labels:
  - mcp-advisor
  - docs
  - orchestrator
dependencies: []
references:
  - orchestrator/src/cli/commands/mcp-setup.ts
  - mcp-advisor/package.json
priority: medium
dispatchable: true
---

## Description

**Source.** Install friction report from the ai-sdlc-io planner session, 2026-11-04, relayed as operator-approved. Operator confirmed this task for dispatch in the ai-sdlc planner session on 2026-11-04.

**Problem.** The MCP advisor path for clients other than Claude Code has no written setup page. The ai-sdlc-io homepage's "Full guide" link has no target. The per-client configs exist only as code in `mcp-setup.ts`, which covers Claude Code, Cursor, VS Code and Windsurf. There is no Codex entry. The planner verified both gaps on main on 2026-11-04.

**Change.**
- A short docs page covering `npx -y @ai-sdlc/mcp-advisor` and the `AI_SDLC_WORKSPACE` variable, with config snippets for Codex (`config.toml`), Cursor, VS Code Copilot and Windsurf.
- A Codex entry in `mcp-setup.ts` that writes the same TOML shape the page documents. The shape in use today is in the sibling repo, at `ai-sdlc-io/.codex/config.toml`. Read it; no cross-repo write is needed.

## Acceptance Criteria

- [ ] AC-1: A docs page exists, linked from `docs/getting-started/`, with working snippets for Codex, Cursor, VS Code Copilot and Windsurf.
- [ ] AC-2: Each snippet matches what `mcp-setup.ts` writes for that client. A test asserts that the page snippets and the generated configs agree, or the PR body explains why a test is not practical.
- [ ] AC-3: `mcp-setup` detects and writes a Codex config, with tests matching the existing per-client tests.
- [ ] AC-4: The page path is stated in the PR body so the ai-sdlc-io site can link to it.
