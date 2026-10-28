# Tutorial 8: Claude Code Plugin

The AI-SDLC framework ships as a **Claude Code plugin** that installs governance
enforcement, workflow commands, review agents, and an MCP server in a single step.
No manual hook configuration needed.

---

## Prerequisites

- Claude Code CLI installed
- A repository with `.ai-sdlc/agent-role.yaml` configured
- Node.js >= 20

---

## Step 1: Install the Plugin

```bash
/plugin marketplace add ai-sdlc-framework/ai-sdlc
/plugin install ai-sdlc@ai-sdlc
/reload-plugins
```

To develop against a local checkout instead, add the repository as a local marketplace (`/plugin marketplace add ./`) and install from it.

This registers all components automatically (the authoritative lists are `ai-sdlc-plugin/plugin.json`, `ai-sdlc-plugin/agents/` and `ai-sdlc-plugin/commands/`):
- **Hooks** for governance enforcement, telemetry and context management (SessionStart, SubagentStart, PreToolUse, PostToolUse, Stop, PermissionRequest)
- **Slash commands** for pipeline operations (`/ai-sdlc execute`, `/ai-sdlc review-pr`, ...)
- **Agents**: the developer, the configured reviewer set (see [reviewer-set-flag.md](../operations/reviewer-set-flag.md)) and resolver agents, with restricted tool pools
- **2 skills** auto-loaded by the plugin (`ai-sdlc-governance`, `decision-rubric`)
- **1 MCP server** with governance, backlog and pipeline tools

---

## Step 2: Hooks — What Fires Automatically

Once the plugin is installed, these hooks run without any configuration:

| Hook | Event | What it does |
|---|---|---|
| `session-start.sh` | SessionStart | Loads `agent-role.yaml` and injects governance context into the session |
| `check-plugin-version.sh` | SessionStart | Warns when the installed plugin is out of date |
| `parent-on-main.sh` | SessionStart, PreToolUse | Checks the parent checkout stays on `main` and blocks writes there |
| `usage-ingest.sh` | SessionStart, Stop | Ingests token usage (async) |
| `subagent-start.sh` | SubagentStart | Injects governance rules into every subagent |
| `enforce-blocked-actions.sh` | PreToolUse | Blocks Bash commands and file writes matching `blockedActions` / `blockedPaths` |
| `enforce-role-tools.sh` | PreToolUse | Enforces the role's tool allow-list |
| `collect-tool-sequence.sh` | PostToolUse | Captures tool calls for workflow pattern detection (async) |
| `context-warn.sh`, `context-budget.sh` | Stop | Context-window warnings and budget |
| `permission-check.sh` | PermissionRequest | Hard deny at permission layer for blocked actions |

The **SessionStart** hook injects context like:

```
## AI-SDLC Governance Active
Role: coding-agent
Goal: Fix bugs and implement small features

### Blocked Actions (NEVER execute these)
- `gh pr merge*`
- `git push --force*`
- `gh pr close*`
...
```

---

## Step 3: Commands

The plugin ships the `/ai-sdlc` command family. The most common ones:

### `/ai-sdlc execute <task-id|pr>`
Runs a backlog task or GitHub issue end to end: worktree, developer subagent, parallel reviewers, attestation, and a draft PR.

### `/ai-sdlc review-pr <pr-number>`
Runs a multi-perspective review on a pull request, using the configured reviewer set ([reviewer-set-flag.md](../operations/reviewer-set-flag.md)): testing, code quality and security.

### `/ai-sdlc triage <issue-number>`
Scores an issue with the RFC-0008 admission composite (PPA plus pillar breakdown).

### `/ai-sdlc fix-pr <pr-number>`
Gathers CI failures and review findings on a PR, fixes them, verifies and pushes.

### `/ai-sdlc rebase <pr-number>` and `/ai-sdlc resolve-conflicts <pr-number>`
Rebase a PR onto main and resolve mechanical conflicts, or invoke the conflict resolver by hand.

### `/ai-sdlc detect-patterns`
Analyzes tool call telemetry to find repeated workflows and propose automations.

### `/ai-sdlc pipeline-status [task-or-issue]`
Shows pipeline status for the current branch or a specific task.

### Session hierarchy
`/ai-sdlc planner`, `/ai-sdlc operator-dispatch` and `/ai-sdlc executor` run the parallel-dispatch hierarchy (RFC-0051); see [cli-hierarchy.md](../operations/cli-hierarchy.md). The older `/ai-sdlc orchestrator-tick` Conductor loop is retired.

Housekeeping commands include `init`, `init-signing-key`, `doctor`, `version`, `cleanup`, `import-spec`, `rfc-init` and `memory-dream`.

---

## Step 4: Agents

The plugin includes these agent definitions (`ai-sdlc-plugin/agents/`), each with a restricted tool pool:

| Agent | Role |
|---|---|
| `developer` | Implements a backlog task, verifies, commits, pushes and opens the PR |
| `code-reviewer`, `test-reviewer`, `security-reviewer` | Review a diff for code quality, test quality and security; `code-reviewer-codex` and `test-reviewer-codex` delegate to Codex |
| `correctness-reviewer` | Combined code and test reviewer (default two-reviewer set) |
| `review-planner`, `review-executor`, `review-executor-codex`, `review-synthesizer` | Staged review: plan probes, run read-only probes, synthesize the verdict |
| `refinement-reviewer` | Definition-of-Ready semantic evaluator |
| `rebase-resolver`, `ci-conflict-resolver` | Rebase a PR and resolve mechanical conflicts |

Key design: **reviewers cannot modify code**. Reviewer agents are read-only (the security reviewer cannot even run Bash), which prevents a compromised review agent from making unauthorized changes.

---

## Step 5: MCP Server Tools

The plugin starts an MCP server that provides tools to the model during a session:

| Tool | Description |
|---|---|
| `check_pr_status` | Get PR checks, reviews, and merge readiness |
| `check_issue` | Get issue details, labels, and triage context |
| `get_governance_context` | Return current agent-role.yaml constraints |
| `list_detected_patterns` | Show workflow patterns from telemetry |
| `get_review_policy` | Return review-policy.md calibration content |

The server also exposes backlog tools (`next_task_id`, `task_create`, `task_edit`, `task_complete`) and the `pipeline_step_*` tools for the Step 0-13 pipeline.

These tools let Claude query governance state during a session without needing
Bash access to the `gh` CLI.

---

## Step 6: SDK Runner (Programmatic Use)

For CI/CD pipelines and automated workflows, use the SDK runner instead of the
CLI-based runner:

```typescript
import { ClaudeCodeSdkRunner } from '@ai-sdlc/orchestrator';

const runner = new ClaudeCodeSdkRunner();
const result = await runner.run({
  issueId: '42',
  issueTitle: 'Fix auth bug',
  issueBody: 'Users cannot log in...',
  workDir: '/path/to/repo',
  branch: 'ai-sdlc/issue-42',
  constraints: {
    maxFilesPerChange: 15,
    requireTests: true,
    blockedPaths: ['.github/workflows/**'],
    blockedActions: ['gh pr merge*'],
    maxBudgetUsd: 5.00,   // Hard cost ceiling
    maxTurns: 100,          // Turn limit
  },
});
```

The SDK runner provides:
- `maxBudgetUsd` — hard cost ceiling enforced by the engine
- `maxTurns` — prevents runaway agents
- `allowedTools` / `disallowedTools` — fine-grained tool filtering
- `appendSystemPrompt` — governance injection without replacing defaults

### Parallel Reviews via SDK

```typescript
import { runParallelSdkReviews } from '@ai-sdlc/orchestrator';

const result = await runParallelSdkReviews({
  diff: prDiffContent,
  prTitle: 'Fix auth module',
  prNumber: 42,
  reviewPolicy: reviewPolicyContent,
  workDir: '/path/to/repo',
});

console.log(result.allApproved);     // true if all configured reviewers approved
console.log(result.verdicts);         // Individual verdicts
console.log(result.totalTokenUsage);  // Combined token usage
```

Each reviewer runs with its own budget cap ($0.50 default) and tool restrictions.

---

## Summary

In this tutorial you:

1. Installed the AI-SDLC **Claude Code plugin** for zero-config governance
2. Understood the **hooks** that fire automatically (enforcement, telemetry, context management)
3. Used the **`/ai-sdlc` slash commands** for pipeline operations
4. Reviewed the **agent definitions** with restricted tool pools
5. Explored the **MCP server tools** for in-session governance queries
6. Learned about the **SDK runner** for programmatic agent control

---

## Next Steps

- **[Action Governance](/docs/api-reference/governance)** — How `blockedActions` and enforcement hooks work.
- **[Workflow Pattern Detection](/docs/tutorials/07-workflow-patterns)** — Automated toil elimination.
- **[Multi-Agent Orchestration](/docs/tutorials/05-multi-agent-orchestration)** — Wire agents into a pipeline.
