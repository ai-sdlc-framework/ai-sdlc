---
id: RFC-0012
title: Two-Tier Pipeline Architecture with Shared Core Library
status: Approved
author: dominique@reliablegenius.io
created: 2026-04-30
updated: 2026-04-30
targetSpecVersion: v1alpha1
requiresDocs: []
---

# RFC-0012: Two-Tier Pipeline Architecture with Shared Core Library

**Status:** Accepted (signed off 2026-04-30; ready for implementation)
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-04-30
**Updated:** 2026-04-30
**Target Spec Version:** v1alpha1
**Supersedes:** AISDLC-82 (execute-orchestrator-as-subagent — empirically unimplementable)

---

## Sign-Off

- [x] Engineering owner — dominique@reliablegenius.io (2026-04-30)
- [x] Operator owner — dominique@reliablegenius.io (2026-04-30)

(Product owner sign-off intentionally omitted: this RFC is internal architecture with no product-facing surface change. The user-visible commands (`/ai-sdlc execute`, `pnpm watch`) work the same way; only the implementation underneath changes.)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-04-30 | dominique | Initial draft after AISDLC-82's empirical failure surfaced the need for a different architecture. All 4 open questions from the design conversation resolved inline. |

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [Architecture](#4-architecture)
5. [The Shared Core Library](#5-the-shared-core-library)
6. [Tier 1 — Attended Interactive (Slash Command)](#6-tier-1--attended-interactive-slash-command)
7. [Tier 2 — Unattended Programmatic (TypeScript Service)](#7-tier-2--unattended-programmatic-typescript-service)
8. [The SubagentSpawner Abstraction](#8-the-subagentspawner-abstraction)
9. [MCP Tool Surface](#9-mcp-tool-surface)
10. [Pipeline Versioning](#10-pipeline-versioning)
11. [Migration Plan](#11-migration-plan)
12. [Backward Compatibility](#12-backward-compatibility)
13. [Alternatives Considered](#13-alternatives-considered)
14. [Implementation Plan](#14-implementation-plan)
15. [Open Questions](#15-open-questions)
16. [References](#16-references)

---

## 1. Summary

Replace the failed AISDLC-82 execute-orchestrator-as-subagent pattern with a **two-tier architecture** that shares a single core library:

- **Tier 1 (Attended Interactive)** — `/ai-sdlc execute <task-id>` slash command body runs Steps 0-13 inline in the main Claude Code session. Subscription-billed (Claude Code Max). Subagents spawn directly via the `Agent` tool (no nested-subagent restriction since main session has Agent).
- **Tier 2 (Unattended Programmatic)** — TypeScript service `executePipeline()` callable from CLI, GitHub Actions, webhooks, cron. Subscription-billed by default via `claude -p` shell-out (operator's logged-in Claude Code session); API-key-billed alternative via Claude Code SDK.
- **Shared Core** — separate npm package `@ai-sdlc/pipeline-cli` containing all deterministic step functions (validate, branch, worktree, attestation sign, push, etc.). Exposed three ways: TypeScript library imports (Tier 2), CLI subcommands (Tier 1 via Bash + portable use outside Claude Code), and MCP tools (plugin-native invocation).

The LLM-driven steps (developer subagent in Step 5, three reviewer subagents in Step 7) are the only tier-specific code. Everything else — git operations, file IO, attestation signing, PR creation, status flips — lives in one place.

This RFC supersedes AISDLC-82, which was based on the incorrect assumption that plugin subagents could spawn nested `Agent` calls. The first parallel-execution test against AISDLC-69.x confirmed the harness blocks this empirically.

## 2. Motivation

### 2.1 AISDLC-82 is unimplementable

The empirical test against AISDLC-69.2 returned: `"No such tool available: Agent. Agent is not available inside subagents."` The Claude Code harness silently filters the `Agent` tool from any plugin-agent subagent invocation, regardless of frontmatter declarations. There is no plugin-side workaround. The execute-orchestrator-as-subagent pattern cannot ship.

### 2.2 We've been doing it the new way already

For the entire session in which the AISDLC-90, AISDLC-93, and AISDLC-99 PRs shipped, the pipeline ran from the **main Claude Code session** — calling git, spawning developer + reviewer subagents directly via the Agent tool, signing attestations, opening PRs. That pattern works. The only thing missing is formalization: extracting the inline orchestration into a reusable library so it doesn't have to be rebuilt by hand each session.

### 2.3 Multiple invocation contexts are the long-term need

- **Today**: operator runs `/ai-sdlc execute X` interactively in a Claude Code session
- **Soon**: `/loop /ai-sdlc execute X` for batch processing
- **Mid-term**: GitHub webhook triggers pipeline on issue creation (Forge ingress for Alex-authored issues per RFC-0011)
- **Mid-term**: cron triggers periodic backlog sweep
- **Future**: external contributors trigger pipeline from their own forks
- **Future**: Forge SaaS customers each have their own pipeline runner

If the pipeline logic lives in one place and exposes clean invocation contracts, every one of these future use cases is "wrap the same library in the right ingress shim" rather than "reimplement the pipeline."

### 2.4 Subscription utilization

We're paying for Claude Code Max-20x. Default to that. Tier 2's default spawner (`ShellClaudePSpawner` via `claude -p`) uses the operator's logged-in subscription, no API tokens consumed. API-key alternative (`ClaudeCodeSDKSpawner`) is for environments where subscription auth isn't available (CI runners, Forge tenants on their own keys).

### 2.5 Portability beyond Claude Code

A separate npm package `@ai-sdlc/pipeline-cli` makes the pipeline runnable in environments that don't have Claude Code installed: bare CI runners, contributor machines using a different IDE, future automation that doesn't speak the Claude Code plugin protocol. The CLI is the lowest-common-denominator interface.

## 3. Goals and Non-Goals

### 3.1 Goals

- **G1.** Single source of truth for pipeline logic — the deterministic helpers live in one place and are unit-testable.
- **G2.** Both attended (slash command) and unattended (service) tiers produce equivalent artifacts (same worktree shape, same attestations, same PR titles).
- **G3.** Subscription billing as the default for both tiers when subscription auth is available.
- **G4.** Portable CLI usable outside Claude Code.
- **G5.** Composable with all existing infrastructure: AISDLC-74/84/85/87/93 (attestations), AISDLC-81 (per-worktree sentinels), AISDLC-83 (cross-repo writes), RFC-0011 DoR gate (when it ships), RFC-0010 worktree pool (when it ships).
- **G6.** Pipeline versioning so attestations record which pipeline version produced them.
- **G7.** No plugin subagent intermediary — slash command body IS the orchestrator.

### 3.2 Non-Goals

- **N1.** Maintain AISDLC-82's "main session fans out N parallel orchestrator subagents" pattern. (Disproven; abandoned.)
- **N2.** Build a new SDK or runtime. We use Claude Code SDK + Claude Code Agent tool + shell-out to `claude -p`. No reinvention.
- **N3.** Replace the existing `orchestrator/src/` TypeScript service. We refactor it to consume the new library; the service interface stays.
- **N4.** Long-running daemon process for queue management. (Defer until volume justifies.)
- **N5.** Auto-detect whether to use Tier 1 or Tier 2 based on context. The tiers are explicit invocation paths; operators choose.

## 4. Architecture

### 4.1 Conceptual diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Tier 1 (Attended)         │  Tier 2 (Unattended)               │
├──────────────────────────────────────────────────────────────────┤
│  /ai-sdlc execute X         │  executePipeline({taskId, ...})    │
│  (slash command body in     │  (TypeScript service, callable     │
│   main Claude Code session) │   from CLI / GHA / webhook / cron) │
│                             │                                    │
│  Subscription auth          │  Default: ShellClaudePSpawner      │
│  (operator's session)       │   (subscription via `claude -p`)   │
│                             │  Alt: ClaudeCodeSDKSpawner         │
│                             │   (API key)                        │
│                             │                                    │
│  Subagents: direct Agent    │  Subagents: SubagentSpawner        │
│  tool calls from main       │   abstraction (interface +         │
│  session                    │   3 implementations)               │
└─────────────────┬───────────────────────────┬────────────────────┘
                  │                           │
                  ▼                           ▼
        ┌────────────────────────────────────────┐
        │     @ai-sdlc/pipeline-cli              │
        │     (Shared Core Library)              │
        ├────────────────────────────────────────┤
        │  Deterministic step functions:         │
        │  • Step 0: sweep merged worktrees      │
        │  • Step 1: validate task spec          │
        │  • Step 2: compute branch name         │
        │  • Step 3: setup worktree              │
        │  • Step 4: flip status + sentinel      │
        │  • Step 5: build developer prompt      │
        │  • Step 6: parse developer return      │
        │  • Step 7: build review prompts (3)    │
        │  • Step 8: aggregate verdicts          │
        │  • Step 10: finalize task + sign       │
        │  • Step 11: push + open PR             │
        │  • Step 12: sibling repo PRs           │
        │  • Step 13: cleanup sentinel + report  │
        │                                        │
        │  Exposed as:                           │
        │  • TypeScript library (Tier 2 import)  │
        │  • CLI subcommands (Tier 1 via Bash)   │
        │  • MCP tools (plugin-native)           │
        └────────────────────────────────────────┘
```

### 4.2 What lives where

| Layer | Location | Responsibility |
|---|---|---|
| Tier 1 entry | `ai-sdlc-plugin/commands/execute.md` body | Prose orchestration: calls CLI for deterministic steps, fires Agent calls for LLM steps |
| Tier 2 entry | `orchestrator/src/pipeline/execute-pipeline.ts` | TypeScript orchestrator function `executePipeline(opts)` |
| Shared core | `pipeline-cli/src/steps/*.ts` (separate npm package) | One file per step, exports a pure function + a CLI subcommand |
| Shared types | `pipeline-cli/src/types.ts` | `PipelineOptions`, `StepResult`, `Verdict`, `SubagentSpawner`, etc. |
| Spawner abstraction | `pipeline-cli/src/runtime/spawner.ts` (interface) + `*-spawner.ts` (impls) | Tier 2 only — abstracts how subagents are invoked |
| MCP wrapping | `ai-sdlc-plugin/mcp-server/src/tools/pipeline-*.ts` | Re-exports the same step functions as MCP tools |
| CLI binary | `pipeline-cli/bin/ai-sdlc-pipeline` | Routes subcommands to step functions |

### 4.3 The four-way exposure of step functions

Every step in the shared core is exposed FOUR ways:

1. **TypeScript function**: `import { sweepMergedWorktrees } from '@ai-sdlc/pipeline-cli';`
2. **CLI subcommand**: `ai-sdlc-pipeline sweep-worktrees`
3. **MCP tool**: `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_sweep_worktrees`
4. **Composite entry point**: `executePipeline()` (Tier 2) or slash command body (Tier 1) calls them in order

This means a user (or a future agent) can invoke any individual step from any context. The TypeScript function is the source of truth; the CLI and MCP wrappings are thin.

## 5. The Shared Core Library

### 5.1 Package: `@ai-sdlc/pipeline-cli`

A separate npm package, published to npm under the `@ai-sdlc` org alongside `@ai-sdlc/orchestrator` and `@ai-sdlc/plugin-mcp-server`.

**Why separate (not part of `orchestrator`):**

- Portable to environments without the orchestrator service installed
- Smaller install footprint for users who only need the CLI
- Cleaner dependency graph: orchestrator depends on pipeline-cli, not the other way around
- Aligns with the user's Q2 answer (portability)

### 5.2 File layout

```
pipeline-cli/
├── package.json              # name: @ai-sdlc/pipeline-cli, bin: ai-sdlc-pipeline
├── src/
│   ├── steps/
│   │   ├── 00-sweep.ts
│   │   ├── 01-validate.ts
│   │   ├── 02-compute-branch.ts
│   │   ├── 03-setup-worktree.ts
│   │   ├── 04-flip-status.ts
│   │   ├── 05-build-dev-prompt.ts
│   │   ├── 06-parse-dev-return.ts
│   │   ├── 07-build-review-prompts.ts
│   │   ├── 08-aggregate-verdicts.ts
│   │   ├── 09-iterate.ts
│   │   ├── 10-finalize.ts
│   │   ├── 11-push-and-pr.ts
│   │   ├── 12-sibling-prs.ts
│   │   └── 13-cleanup.ts
│   ├── runtime/
│   │   ├── subagent-spawner.ts        # interface
│   │   ├── shell-claude-p-spawner.ts  # Tier 2 default (subscription)
│   │   ├── claude-code-sdk-spawner.ts # Tier 2 alt (API key)
│   │   └── mock-spawner.ts            # for tests
│   ├── types.ts
│   ├── execute-pipeline.ts            # Tier 2 composite entry
│   └── cli/
│       └── index.ts                   # CLI subcommand router
├── bin/
│   └── ai-sdlc-pipeline               # shebang wrapper around src/cli/index.ts
└── tests/
    ├── unit/
    │   └── steps/                     # one test file per step
    └── integration/
        └── pipeline.test.ts           # full pipeline test with MockSpawner
```

### 5.3 Step function contract

Every step exports a pure async function with a stable signature:

```typescript
// e.g. pipeline-cli/src/steps/01-validate.ts
import { TaskSpec, ValidateResult } from '../types';

export async function validateTask(opts: {
  taskId: string;
  workDir: string;
}): Promise<ValidateResult> {
  // Read task file, parse frontmatter, validate status/AC/etc.
  // Return structured result OR throw with structured error.
}

// CLI wrapper
export const cliCommand = {
  name: 'validate-task',
  describe: 'Validate a backlog task is ready for execution',
  builder: (yargs) => yargs
    .positional('task-id', { type: 'string', demandOption: true }),
  handler: async (argv) => {
    const result = await validateTask({ taskId: argv.taskId, workDir: process.cwd() });
    console.log(JSON.stringify(result, null, 2));
  },
};
```

### 5.4 What's deterministic vs LLM-driven

| Step | Deterministic? | Notes |
|---|---|---|
| 0 — Sweep merged worktrees | ✓ | git worktree list + gh pr list + git worktree remove |
| 1 — Validate task | ✓ | Read backlog file, check status / AC count / etc. |
| 2 — Compute branch name | ✓ | Title slug + task ID |
| 3 — Setup worktree | ✓ | git worktree add + branch create |
| 4 — Flip status + sentinel | ✓ | Backlog tool / file write + sentinel write |
| 5 — Build developer prompt | ✓ | Pure function: task spec → prompt string |
| 5b — Spawn developer | ✗ LLM | Tier 1: Agent tool. Tier 2: SubagentSpawner. |
| 6 — Parse developer return | ✓ | JSON parse + schema validate + side-effect application |
| 7 — Build review prompts | ✓ | Pure function: diff + task spec → 3 prompt strings |
| 7b — Spawn 3 reviewers | ✗ LLM | Same as 5b |
| 8 — Aggregate verdicts | ✓ | Pure data transform |
| 9 — Iteration loop | ✓ | Calls Steps 5b, 6, 7b, 8 again with feedback context |
| 10 — Finalize task | ✓ | task_edit + task_complete + sign attestation + chore commit |
| 11 — Push + open PR | ✓ | git push + gh pr create |
| 12 — Sibling repo PRs | ✓ | git ops + gh in sibling repos |
| 13 — Cleanup sentinel + report | ✓ | rm sentinel + format report JSON |

**Only Steps 5b and 7b are LLM-driven.** Everything else is pure or side-effecting deterministic code. That's the boundary between "in the library" and "tier-specific."

### 5.5 Iteration loop (Step 9) lives in the library

The iteration loop wraps Steps 5-8 and is itself deterministic — it counts iterations, decides whether to re-spawn the developer with feedback, applies the iteration cap. The LLM-driven sub-steps (5b, 7b) are abstracted via the SubagentSpawner interface (Tier 2) or via prose instructions (Tier 1).

```typescript
// pipeline-cli/src/steps/09-iterate.ts
export async function iterateReviewLoop(opts: {
  taskId: string;
  workDir: string;
  maxIterations: number;        // default 2
  spawner?: SubagentSpawner;    // Tier 2; absent for Tier 1
  onIteration?: (n: number, verdict: AggregatedVerdict) => Promise<void>;
}): Promise<{ finalVerdict: AggregatedVerdict; iterationCount: number }>;
```

For Tier 1, the slash command body runs the iteration loop in prose: "if there are critical/major findings AND iteration < 2, spawn developer again with the feedback prompt; loop." Each Bash call goes through the library; each Agent call is the LLM step.

## 6. Tier 1 — Attended Interactive (Slash Command)

### 6.1 The new `commands/execute.md` body shape

```markdown
---
name: execute
description: Execute a backlog task end-to-end through the AI-SDLC pipeline.
argument-hint: <task-id>
allowed-tools: Bash, Read, Write, Edit, Agent(developer, code-reviewer, test-reviewer, security-reviewer), AskUserQuestion, mcp__backlog__task_view
model: inherit
---

You are running the `/ai-sdlc execute` pipeline against task $ARGUMENTS.

## Step 0 — Sweep merged worktrees

```bash
ai-sdlc-pipeline sweep-worktrees
```

## Step 1 — Validate task

```bash
ai-sdlc-pipeline validate-task $ARGUMENTS
```

If the JSON return shows status != 'To Do' or missing acceptance criteria, refuse with the structured error. Do not proceed.

## Step 2-3 — Compute branch + setup worktree

```bash
ai-sdlc-pipeline setup-worktree $ARGUMENTS
```

Returns `{branch, worktreePath}`. Use these for subsequent steps.

## Step 4 — Flip status + write sentinel

```bash
ai-sdlc-pipeline begin-task $ARGUMENTS
```

(This sets status to In Progress and writes the per-worktree `.active-task` sentinel.)

## Step 5 — Spawn developer

```bash
ai-sdlc-pipeline build-dev-prompt $ARGUMENTS > /tmp/dev-prompt-$ARGUMENTS.json
```

Spawn the developer subagent with the prompt from that file:

`Agent(subagent_type='developer', prompt=<contents of /tmp/dev-prompt-$ARGUMENTS.json>)`

After the developer returns:

```bash
ai-sdlc-pipeline parse-dev-return $ARGUMENTS --return <developer's JSON>
```

(This applies side effects: validates the JSON, records the commit SHA, etc.)

## Step 7 — 3 parallel reviews

```bash
ai-sdlc-pipeline build-review-prompts $ARGUMENTS > /tmp/review-prompts-$ARGUMENTS.json
```

In a single message, fire all 3 reviewer subagents in parallel using the prompts from that file. After all 3 return:

```bash
ai-sdlc-pipeline aggregate-verdicts $ARGUMENTS --verdicts <3 verdicts>
```

## Step 9 — Iterate (up to 2x)

If aggregate verdict has critical/major findings AND iteration < 2:
- Re-build dev prompt WITH `--feedback` flag including the reviewer findings
- Re-spawn developer
- Re-run reviews

Otherwise proceed to Step 10.

## Step 10-13 — Finalize + push + cleanup

```bash
ai-sdlc-pipeline finalize-task $ARGUMENTS
ai-sdlc-pipeline push-and-pr $ARGUMENTS
ai-sdlc-pipeline sibling-prs $ARGUMENTS
ai-sdlc-pipeline cleanup-task $ARGUMENTS
```

Print the final summary report from `cleanup-task`'s output.
```

The body becomes ~80 lines instead of the current ~400. All deterministic logic is in the CLI; the body is orchestration prose + CLI calls + Agent invocations.

### 6.2 Parallel batch mode

```bash
/ai-sdlc execute --batch AISDLC-69.1,AISDLC-69.2,AISDLC-69.3
```

**The scheduling pattern is per-task event-driven, NOT stage-batched Promise.all across tasks.** Each task is its own independent pipeline (state machine: dev-running → reviews-running → finalizing → pushing). The slash command body's batch-mode prose MUST tell Claude to react to each task's notifications individually, not synchronize across tasks at stage boundaries.

Body:

```markdown
## Batch mode

For each task in $TASKS (parsed from --batch), set up worktrees in parallel:

```bash
for TASK in $TASKS; do ai-sdlc-pipeline setup-worktree $TASK; done
```

Then in a single message, spawn N parallel developer subagents (one per task) — this gives Claude Code's "multi-tool-call in one message = parallel" concurrency.

**As each developer's completion notification arrives** (NOT after waiting for all developers):
- Build that task's review prompts: `ai-sdlc-pipeline build-review-prompts $TASK`
- In a single message, spawn THAT TASK's 3 reviewers in parallel
- When THAT TASK's 3 reviewer notifications arrive, aggregate verdicts and iterate-or-finalize for that task

Each task's pipeline (dev → reviews → finalize → push) runs independently. The only cross-task coordination is at the husky pre-push gate (Step 11), which serialises pushes naturally.

**Anti-pattern (DO NOT DO):** "spawn N developers, await all, spawn 3N reviewers, await all, finalize all." That stage-batched Promise.all loses concurrency every time developer durations vary — the slowest developer blocks every other task's reviews from starting.

**Right pattern (DO THIS):** Fire all developers in one message for concurrency, then react per-notification. Each task's reviews start the moment ITS developer finishes, not when the slowest one does.
```

The slash command body uses Claude Code's "multi-tool-call in one message = parallel" semantics for the LLM steps + asynchronous notification model for per-task pipelining. Deterministic steps within ONE task run sequentially via single CLI calls; parallelism is across tasks (developers) and within sub-stages of one task (3 reviewers).

For Tier 2 (TypeScript service): the same per-task pattern falls out of the language naturally — `Promise.all(taskIds.map(id => executePipeline({ taskId: id, spawner })))`. Each `executePipeline()` is its own state machine; concurrency is per-task by construction. No anti-pattern risk because there's no shared stage-batching code path.

### 6.3 Why this works (and AISDLC-82 didn't)

The slash command body runs IN THE MAIN SESSION. Main session has:
- Bash tool ✓
- Agent tool ✓ (only blocked for spawned subagents)
- Read/Write/Edit ✓
- All the MCP tools ✓

No nested subagent invocations needed. The "orchestrator" is Claude in the main session reading the slash command body and following the prose. The shared library handles the deterministic work; Claude handles the LLM dispatch.

## 7. Tier 2 — Unattended Programmatic (TypeScript Service)

### 7.1 Composite entry point

```typescript
// pipeline-cli/src/execute-pipeline.ts

export async function executePipeline(opts: PipelineOptions): Promise<PipelineResult> {
  // Step 0
  await sweepMergedWorktrees({ workDir: opts.workDir });

  // Step 1
  const validation = await validateTask({ taskId: opts.taskId, workDir: opts.workDir });
  if (!validation.ok) throw new ValidationError(validation.reason);

  // Steps 2-3
  const { branch, worktreePath } = await setupWorktree({
    taskId: opts.taskId,
    workDir: opts.workDir,
  });

  // Step 4
  await beginTask({ taskId: opts.taskId, worktreePath });

  // Steps 5-9 (iteration loop)
  const reviewLoop = await iterateReviewLoop({
    taskId: opts.taskId,
    workDir: worktreePath,
    maxIterations: opts.maxReviewIterations ?? 2,
    spawner: opts.spawner,
    onIteration: opts.onProgress,
  });

  // Step 10-13
  await finalizeTask({ taskId: opts.taskId, worktreePath, verdicts: reviewLoop.finalVerdict });
  const prResult = await pushAndPr({ taskId: opts.taskId, worktreePath });
  const siblings = await siblingPrs({ taskId: opts.taskId, worktreePath });
  await cleanupTask({ taskId: opts.taskId, worktreePath });

  return { prUrl: prResult.url, siblingPrUrls: siblings, verdicts: reviewLoop.finalVerdict };
}
```

### 7.2 Invocation contexts

```typescript
// CLI usage (operator's machine, subscription auth via claude -p)
import { executePipeline, ShellClaudePSpawner } from '@ai-sdlc/pipeline-cli';

await executePipeline({
  taskId: process.argv[2],
  spawner: new ShellClaudePSpawner(),  // default for Tier 2
  workDir: process.cwd(),
});

// GitHub Action (CI runner, API key auth)
import { executePipeline, ClaudeCodeSDKSpawner } from '@ai-sdlc/pipeline-cli';

await executePipeline({
  taskId: process.env.TASK_ID,
  spawner: new ClaudeCodeSDKSpawner({ apiKey: process.env.ANTHROPIC_API_KEY }),
  workDir: process.cwd(),
});

// Webhook handler (Forge ingress for Alex-authored issues)
app.post('/webhook/issue-created', async (req, res) => {
  const taskId = await translateGitHubIssueToBacklogTask(req.body);
  await executePipeline({
    taskId,
    spawner: getSpawnerForTenant(req.body.tenant),
    workDir: getTenantWorkDir(req.body.tenant),
  });
});
```

### 7.3 The existing `pnpm watch` migrates to use `executePipeline`

```typescript
// dogfood/src/watch.ts (migration target)
import { executePipeline, ShellClaudePSpawner } from '@ai-sdlc/pipeline-cli';

async function watchHandler(issueId: string) {
  return executePipeline({
    taskId: issueId,
    spawner: new ShellClaudePSpawner(),  // or ClaudeCodeSDKSpawner if API-key
    workDir: REPO_ROOT,
  });
}
```

The current `dogfood/` package's pipeline implementation gets replaced with calls to the shared library. Behavior parity preserved.

## 8. The SubagentSpawner Abstraction

### 8.1 Interface

```typescript
// pipeline-cli/src/runtime/subagent-spawner.ts

export type SubagentType = 'developer' | 'code-reviewer' | 'test-reviewer' | 'security-reviewer';

export interface SpawnOpts {
  type: SubagentType;
  prompt: string;
  cwd: string;
  timeout?: number;          // optional, default 30 min
}

export interface SubagentResult {
  type: SubagentType;
  output: string;            // raw output
  parsed?: unknown;          // structured JSON if the agent returns JSON
  status: 'success' | 'timeout' | 'error';
  error?: string;
  durationMs: number;
}

export interface SubagentSpawner {
  spawn(opts: SpawnOpts): Promise<SubagentResult>;
  spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]>;
}
```

### 8.2 Implementations

#### `ShellClaudePSpawner` (Tier 2 default — subscription)

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export class ShellClaudePSpawner implements SubagentSpawner {
  async spawn(opts: SpawnOpts): Promise<SubagentResult> {
    // Shells out to: claude -p "<prompt>" --cwd <opts.cwd>
    // Uses operator's logged-in Claude Code session (subscription auth)
    const start = Date.now();
    try {
      const { stdout } = await promisify(execFile)('claude', [
        '-p', opts.prompt,
        '--cwd', opts.cwd,
        '--subagent', opts.type,  // hint to load the right system prompt
      ], { timeout: opts.timeout ?? 30 * 60 * 1000 });
      return {
        type: opts.type,
        output: stdout,
        parsed: this.tryParseJSON(stdout),
        status: 'success',
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return { type: opts.type, output: '', status: 'error', error: String(e), durationMs: Date.now() - start };
    }
  }

  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map(o => this.spawn(o)));
  }

  private tryParseJSON(s: string): unknown { /* ... */ }
}
```

**Key benefit:** uses the operator's Claude Code subscription. No API tokens consumed. Each `claude -p` invocation is a fresh ephemeral session.

**Cost:** new process per subagent (no shared session context). In practice this is fine because each subagent gets a self-contained prompt anyway.

#### `ClaudeCodeSDKSpawner` (Tier 2 alternative — API key)

```typescript
import { ClaudeCode } from '@anthropic-ai/claude-code';

export class ClaudeCodeSDKSpawner implements SubagentSpawner {
  constructor(private opts: { apiKey: string; model?: string }) {}

  async spawn(opts: SpawnOpts): Promise<SubagentResult> {
    const client = new ClaudeCode({
      apiKey: this.opts.apiKey,
      model: this.opts.model ?? 'claude-sonnet-4-6',
    });
    const result = await client.runAgent({
      subagentType: opts.type,
      prompt: opts.prompt,
      cwd: opts.cwd,
    });
    return { /* ... */ };
  }

  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map(o => this.spawn(o)));
  }
}
```

For environments where subscription auth isn't available (CI, customer tenants on their own keys).

#### `MockSpawner` (tests)

```typescript
export class MockSpawner implements SubagentSpawner {
  constructor(private fixture: Record<SubagentType, SubagentResult>) {}
  async spawn(opts: SpawnOpts): Promise<SubagentResult> { return this.fixture[opts.type]; }
  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return opts.map(o => this.fixture[o.type]);
  }
}
```

For unit tests of the iteration loop and step orchestration.

### 8.3 Spawner selection

`executePipeline()` requires `opts.spawner`. The caller picks. Convenience wrappers:

```typescript
// "Default Tier 2 spawner" helper
export function defaultSpawner(): SubagentSpawner {
  if (await isClaudeCodeSubscriptionAvailable()) {
    return new ShellClaudePSpawner();
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new ClaudeCodeSDKSpawner({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  throw new Error('No spawner available — install Claude Code OR set ANTHROPIC_API_KEY');
}
```

Tier 1 (slash command body) doesn't use SubagentSpawner — it spawns directly via the Claude Code Agent tool from main session.

## 9. MCP Tool Surface

Per the user's Q3 answer: every step is also exposed as an MCP tool from the plugin's MCP server. This lets agents in any Claude Code session (not just the slash command body) invoke pipeline steps directly.

### 9.1 Tool naming

```
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_sweep_worktrees
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_validate_task
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_setup_worktree
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_begin_task
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_build_dev_prompt
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_parse_dev_return
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_build_review_prompts
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_aggregate_verdicts
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_finalize_task
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_push_and_pr
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_sibling_prs
mcp__plugin_ai-sdlc_ai-sdlc__pipeline_cleanup_task
```

Each tool wraps the corresponding step function from `@ai-sdlc/pipeline-cli`. Same arguments as the CLI subcommand. Same return schema.

### 9.2 Usage example (from any Claude Code session)

```
Operator: "Validate AISDLC-91 and tell me what's wrong with it."

Claude calls: mcp__plugin_ai-sdlc_ai-sdlc__pipeline_validate_task(taskId='AISDLC-91')

Returns: { ok: false, reason: 'no acceptance criteria', ... }
```

The MCP exposure means the steps are reusable building blocks. An agent can use `validate_task` without committing to the full pipeline.

### 9.3 No `pipeline_execute_full` tool

We deliberately do NOT expose a single `pipeline_execute_full(taskId)` MCP tool. Reason: the LLM dispatch (Steps 5b, 7b) needs main-session Agent calls, which an MCP tool can't do (it runs in the MCP server's process). If we want full-pipeline-from-MCP, the MCP server would have to internally use a SubagentSpawner — that's Tier 2's job, not the MCP server's. Keep MCP tools to deterministic steps only.

## 10. Pipeline Versioning

Per the user's Q4 answer: version the pipeline.

### 10.1 Version field in the package

`pipeline-cli/package.json` `version` field is the canonical pipeline version. Bumped via release-please on conventional commit changes.

### 10.2 Recorded in attestation envelope

Update the attestation predicate to include `pipelineVersion`:

```json
{
  "subject": [{ "name": "git+origin", "digest": { "sha1": "<commit-sha>" } }],
  "predicate": {
    "buildType": "ai-sdlc/v1",
    "diffHash": "...",
    "policyHash": "...",
    "agentFileHashes": { ... },
    "pluginVersion": "0.9.0",
    "pipelineVersion": "1.0.0",      // NEW
    "schemaVersion": "v1"
  }
}
```

The verifier records pipeline version but does NOT enforce specific versions (any version that matches the schema allowlist is accepted). This is for forensic / audit purposes — when something breaks, we know which pipeline version produced the artifact.

### 10.3 SemVer for the pipeline

- Major: breaking change to the step contract (different return JSON, new required argument, changed step semantics)
- Minor: new step added, new optional argument, backward-compatible enhancement
- Patch: bug fix in step implementation, no contract change

Steps can be deprecated and removed in major versions. The attestation envelope's `pipelineVersion` field lets us cross-reference what a given attestation was signed against.

## 11. Migration Plan

### 11.1 Phase ordering

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 0** | 1 day | Fix AISDLC-99 (MCP server path bug) — blocking dependency for the MCP-tool-wrapping in Phase 3 | `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` works against this project's actual `backlog/` |
| **Phase 1** | 2-3 days | Create `pipeline-cli/` package; extract step functions from current `orchestrator/`. Behavior-preserving refactor. | All extracted step functions pass unit tests with MockSpawner |
| **Phase 2** | 1 day | Implement `ShellClaudePSpawner` + `ClaudeCodeSDKSpawner` + `MockSpawner` | Spawner unit tests pass |
| **Phase 3** | 1 day | Wrap step functions as MCP tools in plugin's `mcp-server/src/tools/pipeline-*.ts` | All MCP tools callable from a test Claude Code session |
| **Phase 4** | 1 day | Refactor `commands/execute.md` to thin orchestration body using CLI subcommands + Agent calls. Delete `agents/execute-orchestrator.md`. Update agents.test.mjs and execute.test.mjs. | End-to-end manual test: `/ai-sdlc execute <safe-task>` from fresh session completes Steps 0-13 |
| **Phase 5** | 1 day | Refactor `dogfood/src/watch.ts` (Tier 2 entry) to use `executePipeline()` from `pipeline-cli`. | Behavior parity with current `pnpm watch` |
| **Phase 6** | 1 day | Add `pipelineVersion` to attestation envelope; update sign + verify scripts | Test envelope with new field validates |
| **Phase 7** | 0.5 day | Documentation: update CLAUDE.md, write `pipeline-cli` README, write SubagentSpawner doc, write per-step doc | Docs reviewed, all examples runnable |
| **Phase 8** | 0.5 day | Publish `@ai-sdlc/pipeline-cli` to npm; cut a major plugin release that ships the new architecture | Plugin install pulls in CLI binary; both tiers work |

Total: ~8-10 days wall-clock for a full ship. Most phases ship as separate PRs.

### 11.2 Compatibility through migration

During Phases 1-4, both old and new paths coexist:
- Old: `agents/execute-orchestrator.md` still exists (does nothing useful since AISDLC-82 is broken, but doesn't break loaded sessions)
- New: `pipeline-cli` package being built incrementally
- Tier 2 (`pnpm watch`) keeps using its existing implementation

After Phase 4 ships:
- Old `agents/execute-orchestrator.md` deleted
- `commands/execute.md` body uses new architecture
- Tier 1 fully migrated

After Phase 5 ships:
- Tier 2 uses shared library
- Both tiers fully migrated

### 11.3 Rollback plan

Each phase is its own PR. If a phase fails in production:
- Phase 4 rollback: revert the `commands/execute.md` change; old body (which still calls plugin tools etc.) keeps working from Phase 0-3 changes
- Phase 5 rollback: revert `dogfood/src/watch.ts`; old TypeScript pipeline keeps running
- Phases 1-3 are additive — adding new code, not removing — so rollback is just deleting the new package

## 12. Backward Compatibility

This RFC is **partially breaking** for the plugin:

- `ai-sdlc-plugin/agents/execute-orchestrator.md` is **deleted** (Phase 4). Plugin users who somehow have it cached and reference it will see "agent not found" errors.
- `ai-sdlc-plugin/commands/execute.md` body **structurally changes**. The user-facing `/ai-sdlc execute X` command works the same way; the body's implementation is different.
- New dependency: `@ai-sdlc/pipeline-cli` must be installed for the slash command body to work. Plugin's `package.json` adds it as a dependency, so `/plugin install` pulls it in automatically.

For attestation envelopes:
- Existing v1 envelopes (no `pipelineVersion` field) still verify (Phase 6 makes the field optional initially)
- New envelopes have `pipelineVersion`
- 30-day soak before requiring `pipelineVersion` (similar to AISDLC-94's dual-hash migration)

For the Tier 2 service:
- Existing `pnpm --filter @ai-sdlc/dogfood watch --issue X` keeps working before AND after Phase 5 (Phase 5 just changes its internal implementation, public CLI surface unchanged)

## 13. Alternatives Considered

### 13.1 Keep AISDLC-82 + wait for upstream Claude Code

**Rejected.** AISDLC-82's nested-Agent block is not on Anthropic's roadmap (per claude-code-guide research). Indefinite timeline. Meanwhile we'd be stuck with the manual-driver pattern (which is what this RFC formalizes anyway).

### 13.2 Build a custom Agent SDK app instead of two-tier

**Rejected.** The Agent SDK reinvents what Claude Code already provides (subagent dispatch, tool propagation, session management). Pure cost over reusing Claude Code's infrastructure. Also doesn't get subscription auth for free.

### 13.3 MCP-tool-driven full pipeline (single `pipeline_execute_full` tool)

**Rejected (mostly).** MCP tools run in the MCP server's process, which can't directly call the Claude Code Agent tool. To do full-pipeline-from-MCP, the tool would need to internally use a SubagentSpawner. That's Tier 2's job. The `pipeline_*` MCP tools we're shipping are for individual steps (deterministic), not for the LLM dispatch.

### 13.4 Long-running daemon with queue

**Rejected for v1.** Adds operational complexity (daemon to monitor, restart, secure). No volume justifies it yet. Revisit when (a) we have many concurrent tenants or (b) we need persistent queue across operator sessions.

### 13.5 Slash command body with NO shared library (just inline prose)

**Rejected.** That's where AISDLC-82 came from — wanting to avoid duplicating Step 0-13 logic between the slash command and the orchestrator service. The shared library IS the answer to that duplication. Going back to inline prose loses the reusability that makes Tier 2 + GHA + Forge possible.

### 13.6 Single tier — only Tier 1 (slash command)

**Rejected.** Forge / unattended / CI / cron flows can't run in a Claude Code interactive session. Need Tier 2.

### 13.7 Single tier — only Tier 2 (TypeScript service)

**Rejected.** Operator interactive workflow is a real use case; running a TypeScript orchestrator from the terminal during ad-hoc work is friction. Tier 1's slash command is the right ergonomics for that.

## 14. Implementation Plan

Per Section 11. Sequential phases shipped as separate PRs. Each phase is a backlog task (will be filed as AISDLC-100.X sub-tasks per CLAUDE.md "create all tasks before starting work").

The implementation tasks themselves run through `/ai-sdlc execute` using the CURRENT (manual-driver) pattern — which is fine because that pattern works. Phase 4's PR is the one that switches `commands/execute.md` over; subsequent tasks use the new architecture.

## 15. Open Questions

The 4 design questions raised in the architecture conversation were resolved inline:

1. ✅ **Subscription billing for Tier 2 default?** YES — `ShellClaudePSpawner` (subscription via `claude -p`) is Tier 2 default. API-key alternative for environments without subscription auth.
2. ✅ **CLI distribution channel?** Separate npm package `@ai-sdlc/pipeline-cli`. More portable to environments outside Claude Code.
3. ✅ **MCP tool wrapping?** YES — every step exposed as an MCP tool too. Lets agents in any session use individual steps as building blocks.
4. ✅ **Pipeline versioning?** YES — `pipelineVersion` added to attestation envelope. SemVer per package version.

Remaining open questions for implementation:

- **Q5: How does `claude -p` know which subagent to invoke?** — `--subagent <type>` flag is a hypothetical; need to confirm it exists OR design an alternative (prompt prefix?).
- **Q6: Per-tenant spawner config (Forge future)?** — When Forge ships, each tenant may have a different spawner (their own API key, their own subscription account). Design the spawner-selection mechanism with this in mind even if we don't build it for v1.
- **Q7: How to test `claude -p` integration without burning subscription quota?** — Mock spawner for unit tests. For integration tests, run against a single safe task. Document a test budget.
- **Q8: Plugin install path for the CLI binary?** — When `/plugin install ai-sdlc` runs, does it auto-install `@ai-sdlc/pipeline-cli` globally, or as a peer dep? Need to decide and document.

## 16. References

- AISDLC-82 — superseded execute-orchestrator-as-subagent task
- AISDLC-91 — empirical proof that nested Agent calls are blocked
- AISDLC-98 — the architectural revert task that this RFC formalizes
- AISDLC-99 — MCP server path bug (blocking dependency for Phase 3)
- AISDLC-90 — frontmatter fixes (Task→Agent, MCP namespace) — partially undone by this RFC
- AISDLC-93 — bot approval re-post on attestation-skip path
- AISDLC-94 — verifier rebase tolerance (independent)
- AISDLC-95 — verify-attestation neutral conclusion (independent)
- AISDLC-74 / 84 / 85 / 87 — attestation infrastructure (composable with this RFC)
- AISDLC-81 — per-worktree active-task sentinels (still load-bearing in this RFC)
- AISDLC-83 — `permittedExternalPaths` (still load-bearing)
- RFC-0010 — Parallel execution + worktree pooling (composable: RFC-0010's worktree pool can feed Tier 1's batch mode AND Tier 2's batch mode)
- RFC-0011 — Definition-of-Ready Gate (composable: RFC-0011's `evaluateIssue()` library gets called from this RFC's Step 1 validate task)
- The 2026-04-30 conversation that produced this RFC — empirical findings + 4 design questions answered
- `@ai-sdlc/pipeline-cli` (new npm package, to be created in Phase 1)
