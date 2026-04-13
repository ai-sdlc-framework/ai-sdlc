<div align="center">

# AI-SDLC Framework

**Declarative governance for AI-augmented software development lifecycles**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/ai-sdlc-framework/ai-sdlc/actions/workflows/ci.yml/badge.svg)](https://github.com/ai-sdlc-framework/ai-sdlc/actions/workflows/ci.yml)
[![Spec Version](https://img.shields.io/badge/spec-v1alpha1-orange.svg)](#versioning)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Go](https://img.shields.io/badge/Go-1.24+-00add8.svg?logo=go&logoColor=white)](https://go.dev/)
[![Coverage](https://codecov.io/gh/ai-sdlc-framework/ai-sdlc/branch/main/graph/badge.svg)](https://codecov.io/gh/ai-sdlc-framework/ai-sdlc)
[![OpenShell](https://img.shields.io/badge/sandbox-NVIDIA_OpenShell-76b900.svg?logo=nvidia&logoColor=white)](https://github.com/NVIDIA/OpenShell)
[![JSON Schemas](https://img.shields.io/badge/schemas-6_resources-purple.svg)](spec/schemas/)
[![Docs](https://img.shields.io/badge/docs-ai--sdlc.io-0a0a0a.svg)](https://ai-sdlc.io/docs)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Documentation](https://ai-sdlc.io/docs) | [Specification](https://ai-sdlc.io/docs/spec/spec) | [Getting Started](https://ai-sdlc.io/docs/getting-started) | [Contributing](CONTRIBUTING.md)

</div>

---

An open-source orchestrator that drives AI coding agents through the full software development lifecycle — with quality gates, progressive autonomy, and codebase-aware context at every step.

The AI-SDLC Framework takes issues as input and routes them through a declared pipeline of stages, assigning AI agents and/or human reviewers at each stage, enforcing quality gates, and continuously learning which agents can be trusted with what.

---

## The Problem

AI agents can build small greenfield projects, but software falls apart as it grows. Technical debt compounds, complexity overwhelms context windows, and developer velocity collapses:

- **Productivity paradox**: Experienced developers using AI tools are 19% slower on mature codebases, despite believing they are 20% faster (METR 2025)
- **Quality decline**: Refactoring dropped from 25% to 10% of changes; code churn rose from 5.5% to 7.9% (Gitclear 2024)
- **Stability regression**: Every 25% increase in AI adoption correlates with 7.2% drop in system stability (Google DORA)
- **Trust gap**: Only 3% of developers express high trust in AI output (Stack Overflow 2025)

The root cause isn't that AI agents write bad code. It's that **nobody orchestrates how they work as the codebase grows.**

## How It Works

The orchestrator implements a continuous reconciliation loop:

```
1. WATCH    — Listen for triggers (issue assigned, CI failed, schedule)
2. ASSESS   — Analyze codebase complexity, score task complexity (1-10)
3. ROUTE    — Select strategy: fully-autonomous / AI-with-review / human-led
4. EXECUTE  — Invoke agent with context, constraints, and sandbox
5. VALIDATE — Run quality gates (tests, coverage, security, lint)
6. DELIVER  — Create PR with provenance, request review if required
7. LEARN    — Record outcome, update autonomy level, store episodic memory
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       AI-SDLC Orchestrator                           │
│                                                                      │
│  ┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────────┐  │
│  │ Trigger  │───▶│  Route &  │───▶│  Execute  │───▶│  Validate &  │  │
│  │ Watch    │    │  Assign   │    │  Stage    │    │  Promote     │  │
│  └──────────┘    └───────────┘    └───────────┘    └──────────────┘  │
│       │              │                │                   │          │
│       ▼              ▼                ▼                   ▼          │
│  ┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────────┐  │
│  │ Issue    │    │ Complexity│    │ Agent     │    │ Quality      │  │
│  │ Tracker  │    │ Analysis  │    │ Runtime   │    │ Gates        │  │
│  │ Adapter  │    │ + Routing │    │ (sandbox, │    │ + Autonomy   │  │
│  │          │    │           │    │  creds,   │    │   Ledger     │  │
│  │ Linear   │    │ Codebase  │    │  context) │    │              │  │
│  │ Jira     │    │ State     │    │           │    │ Promotion/   │  │
│  │ GitHub   │    │ Store     │    │ Claude    │    │ Demotion     │  │
│  └──────────┘    └───────────┘    │ Copilot   │    └──────────────┘  │
│                                   │ Cursor    │                      │
│                                   │ Codex     │                      │
│                                   │ Any LLM   │                      │
│                                   └───────────┘                      │
│                                                                      │
│  Configured via: .ai-sdlc/pipeline.yaml                              │
│  Codebase state: .ai-sdlc/state/ (autonomy ledger, episodic memory)  │
└──────────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install the orchestrator
npm install -g @ai-sdlc/orchestrator

# Initialize in your repository
ai-sdlc init

# Run a pipeline for a single issue
ai-sdlc run --issue 42

# Or start the long-running orchestrator
ai-sdlc start
```

The `init` command detects your project's language, framework, and CI setup, then generates starter configuration in `.ai-sdlc/`.

## Agent Runners

The orchestrator is **agent-agnostic**. It invokes AI coding agents through a standard `AgentRunner` interface:

| Runner | CLI Command | Auth Env Var | Description |
|---|---|---|---|
| **ClaudeCodeRunner** | `claude -p` | `ANTHROPIC_API_KEY` | Claude Code CLI in `--print` mode |
| **ClaudeCodeSdkRunner** | Agent SDK `query()` | `ANTHROPIC_API_KEY` | Claude Code Agent SDK with budget caps, tool filtering, governance injection |
| **CopilotRunner** | `copilot -p --yolo` | `GH_TOKEN` / `GITHUB_TOKEN` | GitHub Copilot CLI in autonomous mode |
| **CursorRunner** | `cursor-agent --print` | `CURSOR_API_KEY` | Cursor CLI with stream-json output |
| **CodexRunner** | `codex exec -` | `CODEX_API_KEY` | OpenAI Codex CLI via stdin |
| **GenericLLMRunner** | HTTP API | `OPENAI_API_KEY` / `LLM_API_KEY` | Any OpenAI-compatible API endpoint |

All runners support [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox isolation. When configured, agents execute inside kernel-level sandboxes with Landlock filesystem policies, seccomp syscall filtering, and network policy enforcement — without any changes to the agent itself.

Runners are auto-discovered from environment variables. Set the auth token and the runner becomes available:

```bash
export GH_TOKEN=ghp_...           # Enables CopilotRunner
export CURSOR_API_KEY=cur_...     # Enables CursorRunner
export CODEX_API_KEY=cdx_...      # Enables CodexRunner
```

All runners follow the same pattern: build prompt with codebase context, spawn the CLI, collect output, run `git diff` for changed files, stage and commit.

## CLI Commands

| Command | Description |
|---|---|
| `ai-sdlc init` | Scaffold `.ai-sdlc/` config for your project |
| `ai-sdlc run --issue N` | Run pipeline for a single issue |
| `ai-sdlc start` | Start long-running orchestrator (watch mode) |
| `ai-sdlc status [ISSUE]` | Pipeline progress and recent runs |
| `ai-sdlc health` | Orchestrator health check |
| `ai-sdlc agents [NAME]` | Agent roster with autonomy levels |
| `ai-sdlc routing --last 7d` | Task routing distribution |
| `ai-sdlc complexity` | Codebase complexity profile |
| `ai-sdlc cost --last 7d` | Cost summary by agent and pipeline |
| `ai-sdlc dashboard` | Live TUI dashboard |
| `ai-sdlc detect-patterns` | Detect workflow patterns from telemetry data |
| `ai-sdlc list-patterns` | View detected patterns and proposals |
| `ai-sdlc approve-pattern ID` | Generate automation artifact from approved pattern |

## Codebase Intelligence

The orchestrator maintains persistent knowledge about your codebase that agents can't:

- **Complexity analysis** — File count, module structure, dependency graph, overall complexity score (1-10)
- **Architectural patterns** — Detects hexagonal, layered, event-driven patterns and enforces conformance
- **Hotspot identification** — Git history analysis for high-churn, high-complexity files that get extra scrutiny
- **Convention detection** — Naming patterns, test structure, import style injected as agent context
- **Episodic memory** — Records successes, failures, and regressions so agents learn from history
- **Workflow pattern detection** — Observes human-AI interaction sequences across sessions, mines repeated patterns via n-gram analysis, and proposes deterministic automations (commands, skills, hooks, workflows)

## Progressive Autonomy

Agents earn trust through demonstrated competence:

| Level | Name | Capabilities |
|---|---|---|
| 0 | Intern | Read-only, suggestions only |
| 1 | Junior | Can make changes, all PRs require human review |
| 2 | Senior | Can auto-merge low-complexity PRs |
| 3 | Principal | Can handle complex tasks with minimal oversight |

Promotion requires meeting quantitative criteria (PR approval rate, rollback rate, security incidents) plus time-at-level minimums. Demotion is immediate on security incidents.

## Claude Code Plugin

Install the AI-SDLC governance plugin for zero-config enforcement in Claude Code:

```bash
# Add the AI-SDLC marketplace
/plugin marketplace add --source github --repo ai-sdlc-framework/ai-sdlc

# Install the plugin
/plugin install ai-sdlc@ai-sdlc

# Reload to activate
/reload-plugins
```

The plugin provides:

| Component | What it does |
|---|---|
| **6 Hooks** | PreToolUse enforcement, PostToolUse telemetry, SessionStart governance context, Stop quality gates (command + agent + asyncRewake coverage), PermissionRequest deny |
| **5 Commands** | `/review`, `/triage`, `/fix-pr`, `/detect-patterns`, `/status` |
| **3 Agents** | `code-reviewer`, `security-reviewer`, `test-reviewer` — each with restricted tool pools (reviewers can't Edit/Write) |
| **1 Skill** | Governance rules auto-loaded at session start |
| **MCP Server** | 5 tools: `check_pr_status`, `check_issue`, `get_governance_context`, `list_detected_patterns`, `get_review_policy` |

The SDK runner (`ClaudeCodeSdkRunner`) provides programmatic control over agents:

```typescript
import { ClaudeCodeSdkRunner } from '@ai-sdlc/orchestrator';

// Fine-grained agent control via the Agent SDK
const runner = new ClaudeCodeSdkRunner();
await runner.run({
  // ... context
  constraints: {
    maxBudgetUsd: 5.00,     // Hard cost ceiling
    maxTurns: 100,           // Turn limit
    blockedActions: ['gh pr merge*'],
    // ...
  },
});
```

Parallel reviews with per-reviewer tool restrictions and budget caps:

```typescript
import { runParallelSdkReviews } from '@ai-sdlc/orchestrator';

const result = await runParallelSdkReviews({
  diff, prTitle, prNumber, reviewPolicy, workDir,
});
// result.verdicts — 3 parallel reviews (testing, security, quality)
// result.allApproved — true if all reviewers approved
```

## Action Governance

Agents operate under declarative constraints defined in `agent-role.yaml`:

```yaml
spec:
  constraints:
    blockedActions:
      - 'gh pr merge*'       # Only humans merge
      - 'git push --force*'  # No force push
      - 'gh pr close*'       # Only humans close PRs
      - 'git branch -D*'     # No branch deletion
      - 'git reset --hard*'  # No destructive resets
    blockedPaths:
      - '.github/workflows/**'
      - '.ai-sdlc/**'
    requireTests: true
    maxFilesPerChange: 15
```

Enforcement happens at three layers:
1. **Orchestrator** — `checkAction()` validates commands before execution with audit logging
2. **Claude Code hooks** — PreToolUse hook reads `blockedActions` from config and blocks matching Bash commands in real-time
3. **Branch protection** — Required status checks (CI, review, coverage) with `enforce_admins: true`

## Workflow Pattern Detection

The orchestrator observes how developers use AI agents and automatically detects repetitive workflows:

1. **Telemetry** — A PostToolUse hook captures every tool call to JSONL with canonicalized actions
2. **Detection** — N-gram mining (n=3 to 8) finds sequences repeated across 3+ sessions
3. **Classification** — Patterns are classified as command sequences, copy-paste cycles, or periodic tasks
4. **Proposals** — Each pattern generates a draft automation matching project conventions:

| Pattern Type | Output Artifact |
|---|---|
| Command sequence (3+ step chain) | `.claude/commands/<name>.md` |
| Copy-paste cycle (read/write across files) | `.claude/skills/<name>/SKILL.md` |
| Periodic task (regular intervals) | `.github/workflows/<name>.yml` |

**Key principle:** The LLM observes and proposes, but the output is deterministic code — no AI in the runtime loop.

## Specification

The orchestrator is built on a formal specification with five declarative resource types:

| Document | Description |
|---|---|
| [spec.md](spec/spec.md) | Core resource model (Pipeline, AgentRole, QualityGate, AutonomyPolicy, AdapterBinding) |
| [policy.md](spec/policy.md) | Quality gate enforcement levels and evaluation |
| [autonomy.md](spec/autonomy.md) | Progressive autonomy with earned trust |
| [agents.md](spec/agents.md) | Agent roles, handoff contracts, orchestration |
| [adapters.md](spec/adapters.md) | Adapter interface contracts |
| [metrics.md](spec/metrics.md) | Metric definitions and observability |
| [primer.md](spec/primer.md) | Conceptual introduction |

All resource types have [JSON Schema (draft 2020-12)](spec/schemas/) definitions.

## Packages

| Package | Path | Description |
|---|---|---|
| `@ai-sdlc/orchestrator` | [`orchestrator/`](orchestrator/) | The orchestrator runtime — CLI, runners, analysis, state store |
| `@ai-sdlc/sdk` | [`sdk-typescript/`](sdk-typescript/) | TypeScript SDK |
| `ai-sdlc-framework` | [`sdk-python/`](sdk-python/) | Python SDK (`pip install ai-sdlc-framework`) |
| `github.com/ai-sdlc-framework/ai-sdlc/sdk-go` | [`sdk-go/`](sdk-go/) | Go SDK |
| `@ai-sdlc/reference` | [`reference/`](reference/) | TypeScript reference implementation of the spec |
| `@ai-sdlc/conformance` | [`conformance/`](conformance/) | Language-agnostic conformance test suite |
| `@ai-sdlc/mcp-advisor` | [`mcp-advisor/`](mcp-advisor/) | MCP server for human-directed AI usage tracking |
| `ai-sdlc-plugin` | [`ai-sdlc-plugin/`](ai-sdlc-plugin/) | Claude Code plugin — hooks, commands, skills, agents, MCP server |
| `dashboard/` | [`dashboard/`](dashboard/) | Web dashboard (Next.js) for cost, autonomy, and codebase views |
| `spec/` | [`spec/`](spec/) | Formal specification and JSON schemas |
| `docs/` | [`docs/`](docs/) | User-facing documentation |
| `contrib/` | [`contrib/`](contrib/) | Community adapters and plugins |

## Development Setup

```bash
# Prerequisites: Node.js >= 20, pnpm >= 9

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Validate JSON schemas
pnpm validate-schemas
```

## Versioning

The specification follows Kubernetes-style API maturity:

| Stage | Format | Stability |
|---|---|---|
| Alpha | `v1alpha1` | No stability guarantee |
| Beta | `v1beta1` | 9 months support after deprecation |
| GA | `v1` | 12 months support after deprecation |

**Current version: `v1alpha1`**

## Contributing

We welcome contributions of all kinds — bug reports, feature requests, documentation improvements, and code.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute. Changes to normative spec documents require the [RFC process](spec/rfcs/README.md).

## Governance

See [GOVERNANCE.md](GOVERNANCE.md) for project roles, decision making, and SIG structure.

## License

This project is licensed under [Apache 2.0](LICENSE) — use it freely in commercial and open-source projects.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md).

---

<div align="center">

**[Website](https://ai-sdlc.io)** | **[Documentation](https://ai-sdlc.io/docs)** | **[Specification](https://ai-sdlc.io/docs/spec/spec)** | **[Pricing](https://ai-sdlc.io/pricing)**

If you find this project useful, please consider giving it a star.

</div>
