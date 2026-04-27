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
claude --plugin-dir ./ai-sdlc-plugin
```

This registers all components automatically:
- **6 hooks** for governance enforcement and telemetry
- **5 slash commands** for pipeline operations
- **3 review agents** with restricted tool pools
- **1 governance skill** auto-loaded at session start
- **1 MCP server** with 5 governance tools

---

## Step 2: Hooks — What Fires Automatically

Once the plugin is installed, these hooks run without any configuration:

| Hook | Event | What it does |
|---|---|---|
| `session-start.js` | SessionStart | Loads `agent-role.yaml` and injects governance context into the session |
| `enforce-blocked-actions.js` | PreToolUse | Blocks Bash commands matching `blockedActions` patterns |
| `collect-tool-sequence.js` | PostToolUse | Captures tool calls for workflow pattern detection (async) |
| `quality-gate-stop.js` | Stop | Verifies build/test/lint were run before session ends |
| Agent verification | Stop | LLM-powered deep check for governance compliance (Haiku) |
| `deferred-coverage-check.js` | Stop (asyncRewake) | Runs coverage in background, wakes model if below threshold |
| `permission-check.js` | PermissionRequest | Hard deny at permission layer for blocked actions |

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

The plugin adds five slash commands:

### `/review <pr-number>`
Runs a comprehensive three-perspective review on a pull request:
- **Testing** — coverage, edge cases, test quality
- **Code Quality** — logic errors, readability, conventions
- **Security** — injection, auth, secrets, OWASP top 10

### `/triage <issue-number>`
Scores an issue with the Product Priority Algorithm (PPA):
- Conviction, demand, consensus, effort signals
- Trust-based author weighting
- Complexity assessment (1-10) with routing recommendation

### `/fix-pr <pr-number>`
Gathers all failures on a PR (CI, reviews, coverage), checks out the branch,
fixes issues in priority order, runs verification, and pushes.

### `/detect-patterns`
Analyzes tool call telemetry to find repeated workflows and propose automations.

### `/status [issue-number]`
Shows pipeline status for the current branch or a specific issue.

---

## Step 4: Review Agents

The plugin includes three agent definitions with restricted tool pools:

| Agent | Allowed Tools | Disallowed Tools |
|---|---|---|
| `code-reviewer` | Read, Grep, Glob, Bash | Edit, Write, AgentTool |
| `security-reviewer` | Read, Grep, Glob | Bash, Edit, Write, AgentTool |
| `test-reviewer` | Read, Grep, Glob, Bash | Edit, Write, AgentTool |

Key design: **reviewers cannot modify code**. The security reviewer can't even
run Bash commands — it can only read and search. This prevents a compromised
review agent from making unauthorized changes.

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

console.log(result.allApproved);     // true if all 3 reviewers approved
console.log(result.verdicts);         // Individual verdicts
console.log(result.totalTokenUsage);  // Combined token usage
```

Each reviewer runs with its own budget cap ($0.50 default) and tool restrictions.

---

## Summary

In this tutorial you:

1. Installed the AI-SDLC **Claude Code plugin** for zero-config governance
2. Understood the **6 hooks** that fire automatically (enforcement, telemetry, quality gates)
3. Used **5 slash commands** for pipeline operations
4. Reviewed the **3 agent definitions** with restricted tool pools
5. Explored the **MCP server tools** for in-session governance queries
6. Learned about the **SDK runner** for programmatic agent control

---

## Next Steps

- **[Action Governance](/docs/api-reference/governance)** — How `blockedActions` and enforcement hooks work.
- **[Workflow Pattern Detection](/docs/tutorials/07-workflow-patterns)** — Automated toil elimination.
- **[Multi-Agent Orchestration](/docs/tutorials/05-multi-agent-orchestration)** — Wire agents into a pipeline.
