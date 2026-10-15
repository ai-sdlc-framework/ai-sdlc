---
title: "Two-tier pipeline architecture"
description: "The Step 0 to Step 13 execution pipeline and its two callable surfaces: in-session and programmatic."
---

The execution pipeline (Step 0 → Step 13) has two callable surfaces. Tier 1 runs inside a Claude Code session against the operator's subscription. Tier 2 is a library-callable `executePipeline()` driven by an API key. Same pipeline; two billing models.

> **RFC:** [RFC-0012 — Two-Tier Pipeline Architecture](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md)

## Why two tiers

| Tier                      | When you use it                                                                                          | Billing                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Tier 1: slash command** | Internal dogfooding, hands-on work, anything where the operator already has a Claude Code session open   | Claude Code subscription (Max, Pro, etc.) |
| **Tier 2: library**       | Unattended runs, CI, GitHub-issue-triggered dispatch, anything where the operator isn't actively driving | API key (Anthropic, OpenAI, etc.)         |

The slash command body and the library converge on the same step modules (`pipeline-cli/src/steps/*`), so behavior is identical. What differs is **who hosts the agent runtime** and **whose billing pays for it**.

## Tier 1 — slash command

Invoked as `/ai-sdlc execute <task-id>` inside a Claude Code session. The slash command body fans out to `developer`, `code-reviewer`, `test-reviewer`, and `security-reviewer` subagents directly (the main session has the `Agent` tool; plugin subagents do not, which is why the body has to live at the top level — see [RFC-0012 §5.4](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md)).

Parallelism: each `/ai-sdlc execute` is its own Claude Code session, isolated by a per-worktree `.active-task` sentinel. Run `/loop /ai-sdlc execute <id>` or open multiple terminals to fan out.

## Tier 2 — library

```ts
import { executePipeline } from "@ai-sdlc/pipeline-cli";

await executePipeline({
  taskId: "AISDLC-100",
  workDir: process.cwd(),
  spawner: new ApiKeySpawner({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});
```

The `SubagentSpawner` is injected — `ApiKeySpawner` for production API runs, `MockSpawner` for tests. The pipeline's Step 5 (developer fanout) and Step 7 (reviewer fanout) call `spawner.spawn(role, prompt)` rather than the slash-command-body `Agent` tool.

## When to use which

- **Operator at keyboard, internal work** → Tier 1 (`/ai-sdlc execute`)
- **GitHub issue with `ai-eligible` label, no human in the loop** → Tier 2 (the `@ai-sdlc/dogfood watch` daemon)
- **CI-triggered backfill, multi-repo orchestration** → Tier 2
- **Adopter integrations writing their own dispatch** → Tier 2 (import the library)

## Reference

- [`pipeline-cli/README.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/README.md) — package reference, install, runtime deps
- [`pipeline-cli/docs/spawner.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/docs/spawner.md) — SubagentSpawner interface
- [`pipeline-cli/docs/steps.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/docs/steps.md) — Step 0-13 reference
