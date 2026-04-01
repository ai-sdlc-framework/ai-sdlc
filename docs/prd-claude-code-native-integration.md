# PRD: AI-SDLC Native Claude Code Integration

**Status:** Draft
**Author:** AI-SDLC Team
**Date:** 2026-04-01
**Target:** AI-SDLC Framework v0.7.0

---

## Executive Summary

The AI-SDLC framework currently integrates with Claude Code via shell subprocess spawning (`claude -p`) and file-based hooks (`.claude/settings.json`). This PRD proposes a deep native integration that packages AI-SDLC governance as a **Claude Code plugin**, uses the **Agent SDK** for programmatic orchestration, and leverages **agent hooks** for intelligent verification.

The result: any developer who installs the AI-SDLC plugin gets full governance enforcement, workflow detection, and pipeline orchestration — without manual configuration.

---

## Problem Statement

### Current State

1. **Shell subprocess orchestration** — The orchestrator spawns `claude -p --output-format stream-json` as a child process. This gives us output parsing but no control over tool access, budget limits, or real-time hook injection.

2. **File-based hooks only** — Our `enforce-blocked-actions.sh` hook is a shell script that regex-matches commands. It can't inspect file contents, understand context, or make nuanced decisions.

3. **Manual setup required** — Users must manually configure `.claude/settings.json` with hooks, copy governance skills, and ensure `agent-role.yaml` is correct. There's no install-and-go experience.

4. **Limited agent control** — We can't restrict which tools an agent uses, set budget caps, or inject governance context into the system prompt programmatically.

### Desired State

1. `claude plugin install ai-sdlc` — one command installs everything
2. Governance hooks fire automatically — blocked actions, audit logging, review policy enforcement
3. The orchestrator uses the SDK API for fine-grained agent control
4. Workflow pattern detection runs as a background telemetry hook

---

## Research Findings

Five deep-dive investigations into the Claude Code revealed the following integration surfaces.

### 1. Plugin System

Claude Code plugins are directories with a `plugin.json` manifest. A single plugin can contribute:

| Contribution | Mechanism |
|---|---|
| **Hooks** | `hooks/hooks.json` or manifest `hooks` field — all 27 hook events |
| **Commands** | `.md` files in `commands/` — slash commands like `/ai-sdlc:review` |
| **Skills** | `SKILL.md` in `skills/` subdirs — reusable workflows |
| **Agents** | `.md` files in `agents/` — agent definitions with tool restrictions |
| **MCP Servers** | `.mcp.json` or manifest `mcpServers` — expose tools to the model |
| **Settings** | Manifest `settings` field — inject configuration |
| **User Config** | Manifest `userConfig` field — prompt for tokens/keys at install |

**Key capabilities:**
- `SessionStart` hooks can inject `additionalContext` visible to the model (governance rules)
- `PreToolUse` hooks can return `{ decision: 'block' }` to prevent execution
- `PermissionRequest` hooks can return `{ permissionDecision: 'deny' }` for programmatic permission control
- `PostToolUse` hooks can modify tool output via `updatedMCPToolOutput`
- Plugins get `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` variable substitution
- `userConfig` can prompt for API tokens with `sensitive: true` (stored in keychain)

**Distribution:** Plugins are distributed via marketplaces (git repos with `marketplace.json`) or inline via `--plugin-dir`.

### 2. Agent SDK (Programmatic API)

The SDK provides `query()` for programmatic agent invocation with fine-grained control:

```typescript
query({
  prompt: "Fix the bug described in issue #42",
  options: {
    model: "claude-sonnet-4-6",
    maxTurns: 50,
    maxBudgetUsd: 2.00,
    systemPrompt: undefined,        // keep defaults
    appendSystemPrompt: governanceRules,  // inject governance
    allowedTools: ["Bash(git:*)", "Read", "Edit", "Grep", "Glob"],
    disallowedTools: ["WebFetch", "WebSearch"],
    permissionMode: "acceptEdits",
    mcpConfig: ["/path/to/ai-sdlc-mcp.json"],
  }
})
```

**Key capabilities:**
- `maxTurns` and `maxBudgetUsd` — hard limits enforced by the engine
- `allowedTools` / `disallowedTools` — glob patterns like `Bash(git:*)`, `Edit(/src/*)`
- `appendSystemPrompt` — inject governance context without replacing defaults
- `hooks` in `initialize` — register hook callbacks over the NDJSON control protocol
- `mcp_set_servers` — dynamically add/remove MCP tool servers mid-session
- Full NDJSON control protocol for bidirectional communication
- Session persistence with `listSessions()`, `getSessionMessages()`, `forkSession()`

**Limitations:**
- Headless only (no interactive UI)
- Single `initialize` per session (hooks/tools fixed at start)
- V2 session API is unstable (`@alpha`)
- `systemPrompt` replaces ALL defaults (use `appendSystemPrompt` instead)

### 3. Hooks System (27 Events, 4 Types)

Claude Code supports 27 hook events with 4 execution types:

| Type | Execution | Use Case |
|---|---|---|
| `command` | Shell subprocess, JSON stdin/stdout | Fast checks, regex matching, audit logging |
| `prompt` | Single-turn LLM call (Haiku default) | Nuanced policy decisions |
| `agent` | Multi-turn agent with full tool access | Deep verification (read files, run tests, inspect diffs) |
| `http` | HTTPS POST to external service | Centralized audit, compliance reporting |

**Critical hook events for governance:**

| Event | Governance Use |
|---|---|
| `PreToolUse` | Block dangerous operations, enforce blockedActions |
| `PostToolUse` | Audit logging, telemetry collection, output verification |
| `Stop` | Verify all quality gates passed before session ends |
| `SessionStart` | Inject governance context, load agent-role.yaml constraints |
| `PermissionRequest` | Programmatic allow/deny decisions |
| `UserPromptSubmit` | Intercept and validate user instructions |

**Agent hooks** are the most powerful — they spawn a verification sub-agent that can read the transcript, inspect files, run commands, and make a structured `{ok, reason}` decision. Default model: Haiku. Max turns: 50. Timeout: 60s.

**Async rewake** (`asyncRewake: true`): A hook runs in the background after the agent stops. If it exits with code 2, the model is woken with the error — perfect for deferred quality gate checks.

### 4. Coordinator Mode & Worktree Isolation

**Coordinator Mode** — A top-level Claude delegates all work to parallel async workers:
- Coordinator gets only `AgentTool`, `TaskStopTool`, `SendMessageTool`
- Workers run concurrently with independent tool pools
- Workers default to `permissionMode: 'acceptEdits'`
- Per-worker tool filtering: `tools: ['Bash', 'Read', 'Edit']` in agent definition
- Communication via `<task-notification>` XML in user messages

**Git Worktree Isolation** — Agents can work in isolated git worktrees:
- `isolation: 'worktree'` on `AgentTool` spawns work in `.claude/worktrees/agent-<id>/`
- Each worktree gets its own branch
- Auto-cleanup when agent completes with no changes
- Sparse checkout support for large repos

**Limitation:** External users cannot nest agents (sub-agents can't spawn sub-agents). Coordinator mode requires a feature flag.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AI-SDLC Plugin                            │
│  (installed via claude plugin install ai-sdlc)              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  Hooks   │  │ Commands │  │  Skills  │  │   Agents   │  │
│  │          │  │          │  │          │  │            │  │
│  │ PreTool  │  │ /review  │  │ govern-  │  │ code-      │  │
│  │ PostTool │  │ /triage  │  │ ance     │  │ reviewer   │  │
│  │ Session  │  │ /detect  │  │ review   │  │ security-  │  │
│  │ Stop     │  │ /fix-pr  │  │ develop  │  │ reviewer   │  │
│  │ Perm.Req │  │ /admit   │  │          │  │ test-      │  │
│  └──────────┘  └──────────┘  └──────────┘  │ reviewer   │  │
│                                             └────────────┘  │
│  ┌──────────────┐  ┌─────────────────┐                      │
│  │  MCP Server  │  │  User Config    │                      │
│  │              │  │                 │                      │
│  │ check-pr     │  │ github_token    │                      │
│  │ check-issue  │  │ slack_token     │                      │
│  │ get-context  │  │ anthropic_key   │                      │
│  │ list-patterns│  │ project_root    │                      │
│  └──────────────┘  └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
         │                                     │
         ▼                                     ▼
┌─────────────┐                     ┌──────────────────┐
│ Orchestrator│                     │ Telemetry        │
│ SDK Runner  │                     │ Pipeline         │
│             │                     │                  │
│ Uses SDK    │                     │ PostToolUse →    │
│ query() for │                     │ JSONL → n-gram   │
│ fine-grained│                     │ mining →         │
│ agent ctrl  │                     │ proposals        │
└─────────────┘                     └──────────────────┘
```

---

## Detailed Requirements

### Phase 1: AI-SDLC Plugin (Priority: P0)

#### 1.1 Plugin Manifest

```json
{
  "name": "ai-sdlc",
  "version": "0.7.0",
  "description": "AI-SDLC governance framework for Claude Code",
  "author": { "name": "AI-SDLC Framework", "url": "https://ai-sdlc.io" },
  "homepage": "https://ai-sdlc.io",
  "repository": "https://github.com/ai-sdlc-framework/ai-sdlc",
  "license": "Apache-2.0",
  "keywords": ["governance", "sdlc", "security", "quality-gates"],

  "hooks": "./hooks/hooks.json",
  "commands": "./commands/",
  "skills": "./skills/",
  "agents": "./agents/",
  "mcpServers": {
    "ai-sdlc": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/index.js"],
      "env": {
        "GITHUB_TOKEN": "${user_config.github_token}",
        "AI_SDLC_PROJECT_ROOT": "${CLAUDE_PLUGIN_DATA}"
      }
    }
  },
  "userConfig": {
    "github_token": {
      "type": "string",
      "title": "GitHub Token",
      "description": "Personal access token for GitHub API (label management, PR operations)",
      "required": false,
      "sensitive": true
    },
    "slack_webhook": {
      "type": "string",
      "title": "Slack Webhook URL",
      "description": "Webhook for pipeline visibility notifications",
      "required": false
    }
  }
}
```

#### 1.2 Governance Hooks

**`hooks/hooks.json`:**

```json
{
  "SessionStart": [{
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js",
      "statusMessage": "Loading AI-SDLC governance..."
    }]
  }],

  "PreToolUse": [{
    "matcher": "Bash",
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/enforce-blocked-actions.js",
      "if": "Bash(*)",
      "statusMessage": "Checking action policy..."
    }]
  }],

  "PostToolUse": [{
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/collect-telemetry.js",
      "async": true
    }]
  }],

  "Stop": [{
    "hooks": [{
      "type": "agent",
      "prompt": "You are a governance verification agent. Read the session transcript at $ARGUMENTS and verify: 1) No blocked actions were executed. 2) If code was modified, tests exist. 3) No secrets were committed. Return ok:true if all checks pass, ok:false with specific violations if not.",
      "model": "claude-haiku-4-5-20251001",
      "timeout": 30,
      "statusMessage": "Verifying governance compliance..."
    }]
  }],

  "PermissionRequest": [{
    "matcher": "Bash",
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/permission-check.js",
      "if": "Bash(gh pr merge*)"
    }]
  }]
}
```

**Hook implementations:**

| Hook | Event | Type | Purpose |
|---|---|---|---|
| `session-start.js` | SessionStart | command | Load `agent-role.yaml`, inject governance context via `additionalContext` |
| `enforce-blocked-actions.js` | PreToolUse | command | Check Bash commands against `blockedActions` patterns, return `decision: block` |
| `collect-telemetry.js` | PostToolUse | command (async) | Append to JSONL for workflow pattern detection |
| `permission-check.js` | PermissionRequest | command | Hard deny for merge/force-push via `permissionDecision: deny` |
| Stop verification | Stop | agent | LLM-powered deep verification of governance compliance |

#### 1.3 Plugin Commands

| Command | File | Purpose |
|---|---|---|
| `/ai-sdlc:review` | `commands/review.md` | Run parallel review agents on current PR |
| `/ai-sdlc:triage` | `commands/triage.md` | Score and triage a GitHub issue with PPA |
| `/ai-sdlc:detect-patterns` | `commands/detect-patterns.md` | Run workflow pattern detection |
| `/ai-sdlc:fix-pr` | `commands/fix-pr.md` | Gather and fix PR issues |
| `/ai-sdlc:status` | `commands/status.md` | Pipeline status for current branch/issue |

#### 1.4 Plugin Skills

| Skill | Purpose |
|---|---|
| `governance` | Session-start governance rules (replaces `.claude/skills/ai-sdlc-governance/SKILL.md`) |
| `develop` | Full implement-test-commit workflow with pre-commit checklist |
| `review` | Code review with inline comments and severity classification |

#### 1.5 Plugin Agents

Agent definitions with restricted tool pools:

**`agents/code-reviewer.md`:**
```yaml
---
name: ai-sdlc:code-reviewer
description: Reviews code for bugs, logic errors, security vulnerabilities
tools: [Read, Grep, Glob, Bash]
disallowedTools: [Edit, Write, AgentTool]
model: sonnet
---
Review the code changes for this PR. Focus on...
```

**`agents/security-reviewer.md`:**
```yaml
---
name: ai-sdlc:security-reviewer
description: Reviews code for security vulnerabilities and OWASP top 10
tools: [Read, Grep, Glob]
disallowedTools: [Bash, Edit, Write, AgentTool]
model: sonnet
---
Analyze the code changes for security issues...
```

**`agents/test-reviewer.md`:**
```yaml
---
name: ai-sdlc:test-reviewer
description: Reviews test coverage and test quality
tools: [Read, Grep, Glob, Bash]
disallowedTools: [Edit, Write, AgentTool]
model: sonnet
---
Analyze test coverage for the changed files...
```

#### 1.6 MCP Server

An in-plugin MCP server exposing governance tools to the model:

| Tool | Description |
|---|---|
| `check_pr_status` | Get PR check status, reviews, and merge readiness |
| `check_issue` | Score an issue with PPA, get triage status |
| `get_governance_context` | Return current agent-role.yaml constraints |
| `list_detected_patterns` | Return workflow patterns from telemetry |
| `get_review_policy` | Return review-policy.md calibration context |

---

### Phase 2: SDK-Based Orchestrator Runner (Priority: P1)

#### 2.1 New `ClaudeCodeSDKRunner`

Replace the shell subprocess `ClaudeCodeRunner` with an SDK-based runner:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

class ClaudeCodeSDKRunner implements AgentRunner {
  async execute(task: AgentTask, constraints: AgentConstraints): Promise<AgentResult> {
    const result = query({
      prompt: this.buildPrompt(task),
      options: {
        model: constraints.model ?? 'claude-sonnet-4-6',
        maxTurns: constraints.maxTurns ?? 100,
        maxBudgetUsd: constraints.maxBudgetUsd ?? 5.00,
        appendSystemPrompt: this.buildGovernancePrompt(constraints),
        allowedTools: this.buildToolAllowlist(constraints),
        disallowedTools: this.buildToolDenylist(constraints),
        permissionMode: 'acceptEdits',
        mcpConfig: [this.getMcpConfigPath()],
      }
    });

    for await (const message of result) {
      if (message.type === 'assistant') {
        this.onProgress?.(message);
      }
      if (message.type === 'result') {
        return this.parseResult(message);
      }
    }
  }
}
```

**Advantages over shell subprocess:**
- `maxBudgetUsd` — hard cost ceiling enforced by the engine
- `maxTurns` — prevent runaway agents
- `allowedTools` — restrict to only necessary tools (no `WebFetch` for code agents)
- `appendSystemPrompt` — inject governance without losing Claude Code defaults
- Hook callbacks via control protocol — real-time governance decisions
- No stdout parsing — structured NDJSON messages

#### 2.2 Tool Allowlists by Agent Role

Map `agent-role.yaml` tools to SDK tool filters:

```yaml
# agent-role.yaml
spec:
  tools:
    - code-editor    → allowedTools: ["Edit(/src/**)", "Write(/src/**)"]
    - terminal       → allowedTools: ["Bash(pnpm:*)", "Bash(git:*)"]
    - test-runner    → allowedTools: ["Bash(pnpm test*)", "Bash(pnpm build*)"]
    - file-search    → allowedTools: ["Read", "Grep", "Glob"]
```

#### 2.3 Budget and Turn Limits

```yaml
# agent-role.yaml (new fields)
spec:
  constraints:
    maxBudgetUsd: 5.00    # → options.maxBudgetUsd
    maxTurns: 100          # → options.maxTurns
    maxFilesPerChange: 15  # → enforced via PostToolUse hook
```

---

### Phase 3: Advanced Hook Patterns (Priority: P1)

#### 3.1 Agent-Based Stop Hook (Quality Gate Verification)

Replace the manual pre-commit checklist with an agent hook:

```json
{
  "Stop": [{
    "hooks": [{
      "type": "agent",
      "prompt": "You are an AI-SDLC governance verifier. The session transcript is at $ARGUMENTS. Read it and verify:\n1. If code was modified, `pnpm build` was run and passed\n2. If code was modified, `pnpm test` was run and passed\n3. If code was modified, `pnpm lint` was run and passed\n4. No files in blockedPaths (.github/workflows/**, .ai-sdlc/**) were modified\n5. No secrets or API keys appear in committed code\n\nReturn ok:true only if ALL checks pass. Return ok:false with specific violations.",
      "model": "claude-haiku-4-5-20251001",
      "timeout": 45,
      "statusMessage": "Running governance quality gates..."
    }]
  }]
}
```

If the agent returns `ok: false`, Claude is woken with the violations and must fix them before stopping.

#### 3.2 Async Rewake for Deferred Checks

Run coverage analysis after the agent thinks it's done:

```json
{
  "Stop": [{
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/deferred-coverage-check.js",
      "asyncRewake": true,
      "statusMessage": "Checking coverage..."
    }]
  }]
}
```

The script runs `pnpm test -- --coverage` in the background. If coverage drops below threshold, it exits with code 2, waking Claude with the failure details.

---

### Phase 4: Parallel Review via SDK (Priority: P2)

#### 4.1 SDK-Orchestrated Parallel Reviews

Use the SDK to spawn parallel review agents with tool restrictions:

```typescript
const reviews = await Promise.all([
  query({
    prompt: buildReviewPrompt('testing', diff, reviewPolicy),
    options: {
      model: 'claude-sonnet-4-6',
      maxTurns: 20,
      maxBudgetUsd: 0.50,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(pnpm test*)'],
      disallowedTools: ['Edit', 'Write', 'AgentTool'],
      appendSystemPrompt: reviewPolicy,
    }
  }),
  query({
    prompt: buildReviewPrompt('security', diff, reviewPolicy),
    options: {
      model: 'claude-sonnet-4-6',
      maxTurns: 20,
      maxBudgetUsd: 0.50,
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Edit', 'Write', 'AgentTool'],
      appendSystemPrompt: reviewPolicy,
    }
  }),
  query({
    prompt: buildReviewPrompt('quality', diff, reviewPolicy),
    options: {
      model: 'claude-sonnet-4-6',
      maxTurns: 20,
      maxBudgetUsd: 0.50,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(pnpm lint*)'],
      disallowedTools: ['Edit', 'Write', 'AgentTool'],
      appendSystemPrompt: reviewPolicy,
    }
  }),
]);
```

---

## Implementation Plan

| Phase | Weeks | Deliverables |
|---|---|---|
| **1: Plugin** | 1-3 | Manifest, hooks, commands, skills, agents, MCP server, marketplace |
| **2: SDK Runner** | 4-5 | `ClaudeCodeSDKRunner`, tool mapping, budget/turn limits, integration tests |
| **3: Advanced Hooks** | 6-7 | Agent-based Stop hook, async rewake coverage checks |
| **4: Parallel Review** | 8-9 | SDK-orchestrated parallel reviewers with per-agent tool restrictions |

---

## Success Metrics

| Metric | Target |
|---|---|
| Plugin install to working governance | < 2 minutes |
| False positive rate (blocked actions) | 0% |
| Governance bypass rate | 0% |
| Review agent cost per PR | < $1.50 |
| Agent budget overrun | 0 instances |
| Workflow pattern detection coverage | > 80% |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| SDK API is unstable (`@alpha`) | Pin SDK version, abstract behind `AgentRunner` interface |
| Plugin marketplace not yet public | Use `--plugin-dir` for early adopters |
| Agent hooks require Anthropic API key | Use Haiku (cheapest), skip for trivial sessions |
| Coordinator mode requires feature flag | Fall back to SDK `query()` parallel calls |

---

## Appendix: New Files

```
ai-sdlc-plugin/
├── plugin.json                          # Plugin manifest
├── hooks/
│   ├── hooks.json                       # Hook configuration
│   ├── session-start.js                 # SessionStart: load governance context
│   ├── enforce-blocked-actions.js       # PreToolUse: block dangerous actions
│   ├── collect-telemetry.js             # PostToolUse: workflow pattern telemetry
│   ├── permission-check.js              # PermissionRequest: hard deny
│   └── deferred-coverage-check.js       # Stop (asyncRewake): coverage verification
├── commands/
│   ├── review.md                        # /ai-sdlc:review
│   ├── triage.md                        # /ai-sdlc:triage
│   ├── detect-patterns.md               # /ai-sdlc:detect-patterns
│   ├── fix-pr.md                        # /ai-sdlc:fix-pr
│   └── status.md                        # /ai-sdlc:status
├── skills/
│   ├── governance/SKILL.md              # Governance rules
│   ├── develop/SKILL.md                 # Implement-test-commit workflow
│   └── review/SKILL.md                  # Code review workflow
├── agents/
│   ├── code-reviewer.md                 # Read-only code reviewer
│   ├── security-reviewer.md             # Security-focused reviewer
│   └── test-reviewer.md                 # Test coverage reviewer
└── mcp-server/
    └── index.js                         # MCP server with governance tools

orchestrator/src/runners/claude-code-sdk.ts  # New SDK-based runner
orchestrator/src/runners/index.ts            # Export new runner
```
