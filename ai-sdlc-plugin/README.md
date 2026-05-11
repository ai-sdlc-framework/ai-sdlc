# AI-SDLC Plugin

Claude Code plugin providing governance rules, review subagents, and MCP tools for the AI-SDLC framework.

## Subagents (`agents/`)

Plugin subagents are `.md` files with YAML frontmatter declaring tool grants, the harness, and the agent role.

> **Harness note:** Claude Code filters the `Agent` tool out of plugin subagent sessions one level deep — plugin subagents cannot spawn other subagents. The `/ai-sdlc execute` slash command (main session) spawns the developer + reviewers directly.

### Developer

| Agent | Harness | Description |
|-------|---------|-------------|
| `developer` | `claude-code` | Implements backlog tasks end-to-end: plan, code, verify, commit, push, open PR |

### Reviewers — Claude variants (default)

Run inside Claude Code sessions. Spawned by `/ai-sdlc execute` Step 7b.

| Agent | Model | Description |
|-------|-------|-------------|
| `code-reviewer` | inherit | Code quality review: bugs, logic errors, conventions |
| `test-reviewer` | inherit | Test coverage review: existence, quality, edge cases |
| `security-reviewer` | inherit | Security review: OWASP vulnerabilities, injection, secret exposure |

### Reviewers — Codex variants (cross-harness)

Shell out to `codex exec` internally. Use when the developer ran on Claude Code (cross-harness independence) or when Codex is preferred for cost/latency reasons.

**Spawning:** `Agent(subagent_type='ai-sdlc:code-reviewer-codex')` in a slash command body, or by choosing the `-codex` suffix in the `/ai-sdlc execute` harness selection step.

| Agent | Harness | Description |
|-------|---------|-------------|
| `code-reviewer-codex` | `codex` | Code quality review via Codex CLI (`codex exec --model o4-mini`) |
| `test-reviewer-codex` | `codex` | Test coverage review via Codex CLI (`codex exec --model o4-mini`) |

> **Why no `security-reviewer-codex`?** Security review stays on Claude Opus (per `feedback_subagent_model_selection.md`) for its reasoning-heavy OWASP analysis. Codex variants are alternatives only for code/test review where o4-mini is adequate.

All Codex reviewer variants return the **same JSON envelope** as their Claude counterparts:

```json
{
  "approved": true,
  "findings": [
    { "severity": "minor", "file": "src/foo.ts", "line": 42, "message": "..." }
  ],
  "summary": "Overall assessment in 1-2 sentences"
}
```

This makes harness selection transparent to the Step 8 verdict aggregator — no parsing changes needed.

### Utility agents

| Agent | Harness | Description |
|-------|---------|-------------|
| `rebase-resolver` | `claude-code` | Resolves mechanical rebase conflicts (CHANGELOG, lock files, prettier drift) |
| `refinement-reviewer` | `claude-code` | Stage B Definition-of-Ready evaluator (RFC-0011 Phase 2b semantic gates) |

## Slash Commands (`commands/`)

| Command | Description |
|---------|-------------|
| `/ai-sdlc execute <task-id>` | Full pipeline: worktree → developer → 3 reviewers → PR |
| `/ai-sdlc review` | Standalone review pass on the current branch |
| `/ai-sdlc rebase <pr>` | Mechanical rebase + re-sign of an open PR |
| `/ai-sdlc triage` | Issue triage (DOR evaluation + PPA trust) |
| `/ai-sdlc status` | Pipeline status summary |
| `/ai-sdlc cleanup [<task-id>]` | Remove stale worktrees |

## Skills (`skills/`)

| Skill | Description |
|-------|-------------|
| `ai-sdlc-governance` | Auto-loaded governance rules, blocked actions, and pre-commit checklist |

## Path resolution conventions (AISDLC-245.4)

Slash command bodies invoke `@ai-sdlc/pipeline-cli` CLIs and plugin-internal scripts. They must work in two layouts:

| Layout | `CLAUDE_PLUGIN_DIR` | `pipeline-cli` location |
|--------|---------------------|-------------------------|
| Adopter install (npm/marketplace) | Set by Claude Code to the plugin install dir | `$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/` |
| Dogfood monorepo (this repo) | Unset | `$(pwd)/pipeline-cli/` |

**Rule: never hardcode `node pipeline-cli/bin/cli-XXX.mjs` or `node ai-sdlc-plugin/scripts/XXX.mjs` in a slash command body.** Use the portable variables established at the top of every command body:

```bash
# PIPELINE_CLI_BIN — resolves pipeline-cli/bin in both layouts:
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  PIPELINE_CLI_BIN="$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin"
else
  PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
fi

# PLUGIN_SCRIPTS_DIR — resolves plugin-internal scripts (compute-slug.mjs etc.):
PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-$(pwd)/ai-sdlc-plugin}/scripts"
```

Then invoke CLIs as:

```bash
# pipeline-cli binary
node "$PIPELINE_CLI_BIN/cli-deps.mjs" preflight "$TASK_ID" ...

# plugin-internal script
node "$PLUGIN_SCRIPTS_DIR/compute-slug.mjs" "$TASK_FILE"
```

**Note on `CLAUDE_PLUGIN_ROOT`:** for plugin-internal scripts already using `${CLAUDE_PLUGIN_ROOT}` (e.g. `sign-attestation.mjs` invocations in `/ai-sdlc execute` Step 10.5 and `/ai-sdlc rebase`), leave those unchanged — Claude Code injects `CLAUDE_PLUGIN_ROOT` at session start and it is always available in the main session context. `PLUGIN_SCRIPTS_DIR` is only needed for early invocations (before the session hook fires) or in adopter layouts where the harness version may differ.

**Enforcement:** `ai-sdlc-plugin/commands/execute.test.mjs` and `orchestrator-tick.test.mjs` both contain assertions (AISDLC-245.4 suite) that scan the command body for bare `node pipeline-cli/bin/...` invocations and fail the test run if found. When adding a new slash command, copy the path-resolution preamble above and add a similar regression test.

## Cross-harness review

See `docs/operations/cross-harness-review.md` for the bidirectional convention, cost/latency comparison, and Codex CLI prerequisites.

## MCP Server (`mcp-server/`)

The plugin bundles an MCP server (`@ai-sdlc/plugin-mcp-server`) exposing task management and verdict aggregation tools. See `mcp-server/src/tools/` for the tool definitions.

## Testing

```bash
# Agent definition tests (Node built-in runner)
node --test ai-sdlc-plugin/agents/agents.test.mjs

# Command body tests
node --test ai-sdlc-plugin/commands/execute.test.mjs

# MCP server tests (Vitest)
pnpm --filter @ai-sdlc/plugin-mcp-server test
```
