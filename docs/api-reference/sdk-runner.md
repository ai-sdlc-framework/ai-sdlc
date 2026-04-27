# SDK Runner

The `ClaudeCodeSdkRunner` uses the Claude Code Agent SDK's `query()` API for
programmatic agent control with budget caps, turn limits, and fine-grained tool
filtering.

## Import

```typescript
import {
  ClaudeCodeSdkRunner,
  runParallelSdkReviews,
  DEFAULT_REVIEW_CONFIGS,
  type SdkReviewConfig,
  type SdkParallelReviewOptions,
  type SdkParallelReviewResult,
} from '@ai-sdlc/orchestrator';
```

## `ClaudeCodeSdkRunner`

Implements the `AgentRunner` interface using the Agent SDK instead of spawning
a CLI subprocess.

```typescript
class ClaudeCodeSdkRunner implements AgentRunner {
  run(context: AgentContext): Promise<AgentResult>;
}
```

### Advantages over `ClaudeCodeRunner`

| Feature | CLI Runner | SDK Runner |
|---|---|---|
| Budget cap | No | `maxBudgetUsd` enforced by engine |
| Turn limit | No | `maxTurns` enforced by engine |
| Tool filtering | Allowlist only | `allowedTools` + `disallowedTools` with globs |
| Governance injection | Prompt only | `appendSystemPrompt` preserves defaults |
| Output parsing | Stdout NDJSON | Structured messages |
| Progress events | Parsed from stream | Native callbacks |

### Usage

```typescript
const runner = new ClaudeCodeSdkRunner();

const result = await runner.run({
  issueId: '42',
  issueTitle: 'Fix authentication bug',
  issueBody: 'Users cannot log in with SSO...',
  workDir: '/path/to/repo',
  branch: 'ai-sdlc/issue-42',
  model: 'claude-sonnet-4-6',
  constraints: {
    maxFilesPerChange: 15,
    requireTests: true,
    blockedPaths: ['.github/workflows/**'],
    blockedActions: ['gh pr merge*', 'git push --force*'],
    maxBudgetUsd: 5.00,
    maxTurns: 100,
  },
  onProgress: (event) => {
    console.log(`${event.type}: ${event.tool ?? event.message}`);
  },
});

console.log(result.success);       // boolean
console.log(result.filesChanged);  // string[]
console.log(result.tokenUsage);    // { inputTokens, outputTokens, model }
```

### Constraint Mapping

| `AgentContext` field | SDK option |
|---|---|
| `model` | `options.model` |
| `constraints.maxBudgetUsd` | `options.maxBudgetUsd` |
| `constraints.maxTurns` | `options.maxTurns` |
| `allowedTools` | `options.allowedTools` |
| `constraints.blockedActions` | `options.disallowedTools` (as `Bash()` patterns) |
| Governance context | `options.appendSystemPrompt` |

---

## `runParallelSdkReviews(options)`

Spawn 3 concurrent SDK review queries with per-reviewer tool restrictions and
budget caps.

```typescript
async function runParallelSdkReviews(
  options: SdkParallelReviewOptions,
): Promise<SdkParallelReviewResult>;
```

### Parameters

```typescript
interface SdkParallelReviewOptions {
  diff: string;              // PR diff content
  prTitle: string;           // PR title
  prNumber: number;          // PR number
  reviewPolicy?: string;     // .ai-sdlc/review-policy.md content
  workDir: string;           // Working directory for tool access
  reviewConfigs?: SdkReviewConfig[];  // Override default configs
  model?: string;            // Model override for all reviewers
}
```

### Result

```typescript
interface SdkParallelReviewResult {
  verdicts: ReviewVerdict[];     // One per reviewer
  allApproved: boolean;          // true if all reviewers approved
  totalTokenUsage: TokenUsage;   // Combined token usage
  errors: string[];              // Any reviewer failures
}
```

### Default Review Configurations

| Reviewer | Allowed Tools | Disallowed Tools | Budget |
|---|---|---|---|
| Testing | Read, Grep, Glob, Bash(pnpm test*) | Edit, Write, AgentTool | $0.50 |
| Security | Read, Grep, Glob | Bash, Edit, Write, AgentTool | $0.50 |
| Quality | Read, Grep, Glob, Bash(pnpm lint*) | Edit, Write, AgentTool | $0.50 |

### Example

```typescript
import { runParallelSdkReviews } from '@ai-sdlc/orchestrator';

const result = await runParallelSdkReviews({
  diff: await fs.readFile('/tmp/pr.diff', 'utf-8'),
  prTitle: 'Fix auth module',
  prNumber: 42,
  reviewPolicy: await fs.readFile('.ai-sdlc/review-policy.md', 'utf-8'),
  workDir: process.cwd(),
});

if (result.allApproved) {
  console.log('All reviewers approved');
} else {
  for (const verdict of result.verdicts) {
    if (!verdict.approved) {
      console.log(`${verdict.type}: ${verdict.summary}`);
      for (const f of verdict.findings) {
        console.log(`  ${f.severity}: ${f.file}:${f.line} — ${f.message}`);
      }
    }
  }
}
```

---

## Prerequisites

The SDK runner requires `@anthropic-ai/claude-agent-sdk` as an optional peer
dependency. If not installed, the runner returns an error with installation
instructions.

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```
