# Agent Runners

The orchestrator invokes AI coding agents through the `AgentRunner` interface. Runners are auto-discovered from environment variables via the `RunnerRegistry`.

## AgentRunner Interface

Every runner implements:

```typescript
interface AgentRunner {
  run(ctx: AgentContext): Promise<AgentResult>;
}
```

The orchestrator provides context (issue details, codebase profile, constraints) and the runner spawns the agent, collects output, and commits changes.

## Available Runners

### ClaudeCodeRunner

Invokes [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI in `--print` mode.

| Property | Value |
|---|---|
| CLI command | `claude -p --model <model> --allowedTools <tools>` |
| stdin | Prompt sent via stdin |
| Auth | `ANTHROPIC_API_KEY` (inherited from environment) |
| Model override | `AI_SDLC_MODEL` env var (default: `claude-sonnet-4-5-20250929`) |
| Registration | Always available (built-in) |

```typescript
import { ClaudeCodeRunner } from '@ai-sdlc/orchestrator';
```

### CopilotRunner

Invokes [GitHub Copilot CLI](https://docs.github.com/en/copilot) in `--yolo` autonomous mode.

| Property | Value |
|---|---|
| CLI command | `copilot -p <prompt> --yolo [--model <model>]` |
| stdin | None (prompt is a CLI argument) |
| Auth | `GH_TOKEN` or `GITHUB_TOKEN` (passed through environment) |
| Model override | `AI_SDLC_COPILOT_MODEL` env var |
| Registration | Available when `GH_TOKEN` or `GITHUB_TOKEN` is set |

```typescript
import { CopilotRunner } from '@ai-sdlc/orchestrator';
```

### CursorRunner

Invokes [Cursor](https://www.cursor.com/) CLI agent with NDJSON stream output.

| Property | Value |
|---|---|
| CLI command | `cursor-agent --print <prompt> --force --output-format=stream-json [-m <model>]` |
| stdin | None (prompt is a CLI argument) |
| Auth | `CURSOR_API_KEY` |
| Model override | `AI_SDLC_CURSOR_MODEL` env var |
| Registration | Available when `CURSOR_API_KEY` is set |

The runner parses NDJSON output to extract the final assistant message for use as the PR summary.

```typescript
import { CursorRunner, parseStreamJson } from '@ai-sdlc/orchestrator';
```

### CodexRunner

Invokes [OpenAI Codex CLI](https://github.com/openai/codex) in `--full-auto --json` mode.

| Property | Value |
|---|---|
| CLI command | `codex exec - --full-auto --json [-m <model>]` |
| stdin | Prompt written to stdin (Codex reads from `-`) |
| Auth | `CODEX_API_KEY` |
| Model override | `AI_SDLC_CODEX_MODEL` env var |
| Registration | Available when `CODEX_API_KEY` is set |

The runner includes an enhanced token usage parser that first tries NDJSON `usage`/`token_usage` events from stderr (accumulating across multiple events), then falls back to regex.

```typescript
import { CodexRunner, parseTokenUsage } from '@ai-sdlc/orchestrator';
```

### GenericLLMRunner

Invokes any OpenAI-compatible chat completions API over HTTP.

| Property | Value |
|---|---|
| Transport | HTTP POST to `/v1/chat/completions` endpoint |
| Auth | API key via `Authorization: Bearer` header |
| Registration | Available when `OPENAI_API_KEY` or `LLM_API_KEY` + `LLM_API_URL` is set |

```typescript
import { GenericLLMRunner } from '@ai-sdlc/orchestrator';
```

## Runner Registry

The `RunnerRegistry` manages discovery and selection of runners:

```typescript
import { createRunnerRegistry } from '@ai-sdlc/orchestrator';

const registry = createRunnerRegistry();

// List all available runners
const available = registry.listAvailable();
console.log(available.map(r => r.name));
// ['claude-code', 'copilot', 'cursor', ...]

// Get a specific runner
const runner = registry.get('copilot');

// Get the default runner (first available)
const defaultRunner = registry.getDefault();
```

### Auto-Discovery

`discoverFromEnv()` registers runners based on environment variables:

| Runner | Required Env Var(s) | Source |
|---|---|---|
| `claude-code` | _(always available)_ | `built-in` |
| `copilot` | `GH_TOKEN` or `GITHUB_TOKEN` | `env` |
| `cursor` | `CURSOR_API_KEY` | `env` |
| `codex` | `CODEX_API_KEY` | `env` |
| `openai` | `OPENAI_API_KEY` | `env` |
| `anthropic` | `ANTHROPIC_API_KEY` | `env` |
| `generic-llm` | `LLM_API_URL` + `LLM_API_KEY` | `env` |

### Manual Registration

You can register custom runners:

```typescript
import { RunnerRegistry } from '@ai-sdlc/orchestrator';

class MyCustomRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    // Custom agent invocation logic
  }
}

const registry = new RunnerRegistry();
registry.register('my-agent', new MyCustomRunner());
```

## OpenShell Sandbox Integration

When the `sandboxId` field is set on `AgentContext`, CLI-based runners execute the agent inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox. The runner prefixes the spawn command with `openshell sandbox connect <id> --`, so instead of:

```
claude -p --model claude-sonnet-4-5-20250929 --allowedTools Edit,Write,...
```

it becomes:

```
openshell sandbox connect aisdlc-issue-42-1711316400 -- claude -p --model claude-sonnet-4-5-20250929 --allowedTools Edit,Write,...
```

This provides kernel-level isolation (Landlock filesystem policies, seccomp syscall filtering, network policy enforcement) without any changes to the agent itself. The orchestrator's `executePipeline()` automatically passes `sandboxId` when a `SecurityContext` with an OpenShell sandbox is configured.

See [Security > OpenShell](./security.md#createopenshellsandboxexec-config) for setup details.

## Common Pattern

All CLI-based runners (Claude Code, Copilot, Cursor, Codex) follow the same subprocess pattern:

1. **Build prompt** — `buildPrompt(ctx)` constructs a prompt from issue details, constraints, codebase context, and episodic memory
2. **Spawn CLI** — Run the agent CLI as a child process with appropriate flags
3. **Collect output** — Buffer stdout and stderr
4. **Parse token usage** — Extract input/output token counts from stderr for cost tracking
5. **Git diff** — Run `git diff --name-only` and `git ls-files --others` to find changed files
6. **Commit** — `git add -A` and `git commit` with the configured message template and co-author

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AI_SDLC_MODEL` | `claude-sonnet-4-5-20250929` | Model for ClaudeCodeRunner |
| `AI_SDLC_COPILOT_MODEL` | _(CLI default)_ | Model override for CopilotRunner |
| `AI_SDLC_CURSOR_MODEL` | _(CLI default)_ | Model override for CursorRunner |
| `AI_SDLC_CODEX_MODEL` | _(CLI default)_ | Model override for CodexRunner |
| `AI_SDLC_RUNNER_TIMEOUT` | `900000` (15 min) | Runner timeout in ms (supports duration strings) |
| `AI_SDLC_LINT_COMMAND` | _(none)_ | Lint command injected into agent prompts |
| `AI_SDLC_FORMAT_COMMAND` | _(none)_ | Format command injected into agent prompts |
| `AI_SDLC_COMMIT_MESSAGE_TEMPLATE` | `fix: resolve issue #{issueNumber}\n\n{issueTitle}` | Commit message template |
| `AI_SDLC_COMMIT_CO_AUTHOR` | `Claude <noreply@anthropic.com>` | Co-author for commits |
