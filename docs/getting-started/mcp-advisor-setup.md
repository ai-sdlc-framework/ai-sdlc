# MCP advisor setup

Stable path: `docs/getting-started/mcp-advisor-setup.md`

The MCP advisor is the `@ai-sdlc/mcp-advisor` package. Every client launches it the same way:

```text
npx -y @ai-sdlc/mcp-advisor
```

Set `AI_SDLC_WORKSPACE` to the workspace root (`.` for the directory the client opens) when the repository is a multi-repo workspace. Leave it out for a single repository.

Claude Code users do not need this page: `/ai-sdlc setup` (or `ai-sdlc init`) writes `.mcp.json` for you. For every other client, `ai-sdlc init` writes the files below when it detects the client (a `.codex/`, `.cursor/`, `.vscode/` or `.windsurf/` directory, or the client binary on PATH; Cursor needs `--cursor` or a `.cursor/` directory). To pin a version, use `@ai-sdlc/mcp-advisor@<version>` in `args`. The snippets below show the workspace form and are checked against the generated output by a test.

## Codex

`.codex/config.toml`

```toml
[mcp_servers.ai-sdlc]
command = "npx"
args = ["-y", "@ai-sdlc/mcp-advisor"]

[mcp_servers.ai-sdlc.env]
AI_SDLC_WORKSPACE = "."
```

## Cursor

`.cursor/mcp.json`

```json
{
  "mcpServers": {
    "ai-sdlc": {
      "command": "npx",
      "args": ["-y", "@ai-sdlc/mcp-advisor"],
      "env": {
        "AI_SDLC_WORKSPACE": "."
      }
    }
  }
}
```

## VS Code Copilot

`.vscode/mcp.json`

```json
{
  "servers": {
    "ai-sdlc": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ai-sdlc/mcp-advisor"],
      "env": {
        "AI_SDLC_WORKSPACE": "."
      }
    }
  }
}
```

## Windsurf

`.windsurf/mcp.json`

```json
{
  "mcpServers": {
    "ai-sdlc": {
      "command": "npx",
      "args": ["-y", "@ai-sdlc/mcp-advisor"],
      "env": {
        "AI_SDLC_WORKSPACE": "."
      }
    }
  }
}
```
