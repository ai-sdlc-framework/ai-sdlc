# Orchestrator Inline Loop — Consumer Bridge Protocol

**Status**: Production-ready (AISDLC-225)
**RFC**: RFC-0015 §8.2 / AISDLC-198 Option 3
**Component**: `/ai-sdlc orchestrator-tick` slash command

---

## Overview

The autonomous pipeline orchestrator (`cli-orchestrator`) runs in two billing
modes. The **inline mode** (`--spawner claude-cli`) uses the operator's
existing Claude Code Max subscription — no separate `claude -p` subprocess,
no API-key billing.

The inline mode is implemented as a two-part protocol:

| Part | Component | Role |
|---|---|---|
| **Producer** | `ClaudeCliInlineSpawner` (`AISDLC-198`) | Writes `dispatch-manifest.json`; returns `manifest-emitted` status |
| **Consumer** | `/ai-sdlc orchestrator-tick` (`AISDLC-225`) | Reads manifest; invokes `Agent` tool; writes `dispatch-result.json` |

This document describes the consumer side — how the slash command body bridges
the manifest into a live `Agent` tool call and hands the result back to the
orchestrator's tick loop.

---

## Why a slash command, not a subagent

Plugin subagents **cannot** use the `Agent` tool. Claude Code filters it out
one level deep — verified empirically (AISDLC-69.2 test returned `"No such
tool available: Agent. Agent is not available inside subagents."`).

The slash command body runs in the **main Claude Code session**, which DOES
have the `Agent` tool. That's why `/ai-sdlc orchestrator-tick` must live in
`ai-sdlc-plugin/commands/`, not in a subagent.

---

## File layout

```
$ARTIFACTS_DIR/_orchestrator/
  dispatch-manifest.json   ← producer writes (ClaudeCliInlineSpawner)
  dispatch-result.json     ← consumer writes (/ai-sdlc orchestrator-tick)
```

Both files persist between ticks as **observability artifacts**. Operators can
inspect them to understand what the orchestrator most recently dispatched and
what the subagent returned.

---

## Dispatch manifest shape

Written by `ClaudeCliInlineSpawner.spawn()`:

```json
{
  "version": 1,
  "taskId": "AISDLC-123",
  "subagentType": "developer",
  "model": "claude-sonnet-4-6",
  "prompt": "<full task prompt>",
  "cwd": "/path/to/.worktrees/aisdlc-123",
  "runInBackground": false,
  "emittedAt": "2026-05-06T00:00:00.000Z"
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `version` | `1` | Schema version |
| `taskId` | `string` | Task being dispatched (e.g. `AISDLC-123`) |
| `subagentType` | `SubagentType` | One of `developer`, `code-reviewer`, `test-reviewer`, `security-reviewer` |
| `model` | `string \| null` | Model to pass to the `Agent` tool (`null` = session default) |
| `prompt` | `string` | Full prompt text for the subagent |
| `cwd` | `string \| undefined` | Working directory for the subagent |
| `runInBackground` | `boolean` | Whether to invoke Agent in background mode |
| `emittedAt` | `string` | ISO-8601 timestamp |

---

## Dispatch result shape

Written by `/ai-sdlc orchestrator-tick` after the `Agent` call:

```json
{
  "version": 1,
  "taskId": "AISDLC-123",
  "subagentType": "developer",
  "status": "success",
  "output": "<raw Agent output>",
  "parsed": {
    "summary": "...",
    "commitSha": "abc1234",
    "prUrl": "https://github.com/org/repo/pull/42",
    "filesChanged": ["..."],
    "verifications": { "build": "passed", "test": "passed", "lint": "passed", "format": "passed" },
    "acceptanceCriteriaMet": [1, 2, 3]
  },
  "durationMs": 120000,
  "writtenAt": "2026-05-06T00:01:02.000Z"
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `version` | `1` | Schema version |
| `taskId` | `string` | Task that was dispatched |
| `subagentType` | `SubagentType` | Subagent type that was invoked |
| `status` | `'success' \| 'error'` | Outcome of the Agent call |
| `output` | `string` | Raw Agent output (stdout + natural language) |
| `parsed` | `unknown \| undefined` | Parsed JSON return (developer envelope or reviewer verdict) |
| `error` | `string \| undefined` | Error message when `status === 'error'` |
| `durationMs` | `number` | Wall-clock duration of the Agent call |
| `writtenAt` | `string` | ISO-8601 timestamp when this result was written |

The `parsed` field is what `executePipeline()` consumes to continue from
Step 6 onward. For developer subagents, it carries the standard JSON return
envelope. For reviewer subagents, it carries the verdict object.

---

## Full tick sequence

```
Operator's Claude Code session
│
│  /ai-sdlc orchestrator-tick
│  │
│  ├── Step 1: Check AI_SDLC_AUTONOMOUS_ORCHESTRATOR
│  │
│  ├── Step 2: node pipeline-cli/bin/cli-orchestrator.mjs tick --max-concurrent 1
│  │     │
│  │     └── Orchestrator tick loop:
│  │           - Reads frontier (cli-deps)
│  │           - Runs admission filters (DoR, deps, blocked)
│  │           - For admitted tasks: ClaudeCliInlineSpawner.spawn()
│  │               → writes dispatch-manifest.json
│  │               → returns { status: 'manifest-emitted', manifest }
│  │           - Tick exits with JSON including outcomes
│  │
│  ├── Step 3: Detect manifest-emitted in tick output
│  │
│  ├── Step 4: Read $ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json
│  │
│  ├── Step 5: Invoke Agent tool
│  │     - subagentType = manifest.subagentType
│  │     - prompt = manifest.prompt
│  │     - model = manifest.model (when set)
│  │     - cwd = manifest.cwd
│  │     └── Agent runs the developer/reviewer subagent
│  │
│  ├── Step 6: Write $ARTIFACTS_DIR/_orchestrator/dispatch-result.json
│  │     - status: 'success' | 'error'
│  │     - output: raw Agent output
│  │     - parsed: Agent's JSON return
│  │     - durationMs: wall-clock
│  │
│  ├── Step 7: node pipeline-cli/bin/cli-orchestrator.mjs tick --continue-from-result
│  │     └── Tick reads dispatch-result.json → constructs SubagentResult
│  │           → continues executePipeline() Steps 6+
│  │             (review dispatch, attestation, PR open)
│  │
│  └── Step 8: ScheduleWakeup(30s) — or exit if --once
```

---

## TypeScript helpers

The `pipeline-cli/src/runtime/spawners/dispatch-result.ts` module provides:

| Export | Purpose |
|---|---|
| `resolveResultPath(override?)` | Canonical path resolution (mirrors `resolveManifestPath`) |
| `writeDispatchResult(result, opts)` | Consumer writes the Agent result |
| `readDispatchResult(opts)` | Tick loop reads the result back |
| `isDispatchResult(value)` | Type-guard for the result file shape |
| `dispatchResultToSubagentResult(result)` | Converts to `SubagentResult` for `executePipeline()` |

```typescript
// Slash command body (after Agent call):
import { writeDispatchResult } from 'pipeline-cli/src/runtime/spawners/dispatch-result.js';

writeDispatchResult({
  taskId: 'AISDLC-123',
  subagentType: 'developer',
  status: 'success',
  output: agentOutput,
  parsed: JSON.parse(agentOutput),
  durationMs: Date.now() - startMs,
});

// Orchestrator tick loop (continuation):
import {
  readDispatchResult,
  dispatchResultToSubagentResult,
} from 'pipeline-cli/src/runtime/spawners/dispatch-result.js';

const dispatchResult = readDispatchResult();
if (dispatchResult) {
  const subagentResult = dispatchResultToSubagentResult(dispatchResult);
  // Pass subagentResult to executePipeline() Steps 6+
}
```

---

## Running the inline orchestrator

### Prerequisites

1. Set the feature flag:
   ```bash
   export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
   ```

2. Build the pipeline-cli:
   ```bash
   pnpm build
   ```

3. Ensure `$ARTIFACTS_DIR` is set (or let it default to `./artifacts/`):
   ```bash
   export ARTIFACTS_DIR="$(pwd)/artifacts"
   ```

### Start a loop

Option A — `/loop` (operator-managed cadence):
```
/loop /ai-sdlc orchestrator-tick
```

Option B — single tick + ScheduleWakeup (autonomous, background):
```
/ai-sdlc orchestrator-tick
```
This runs one tick and schedules the next one in 30s automatically.

Option C — single tick for debugging:
```
/ai-sdlc orchestrator-tick --once
```

### Monitor

Between ticks, inspect the observability artifacts:
```bash
cat artifacts/_orchestrator/dispatch-manifest.json   # last dispatch decision
cat artifacts/_orchestrator/dispatch-result.json     # last Agent result
```

---

## Difference from the API-key path

| Aspect | API-key (`--spawner api-key`) | Inline (`--spawner claude-cli`) |
|---|---|---|
| Billing | Anthropic API credits | Claude Code Max subscription |
| Session | Separate `claude -p` subprocess | Same operator Claude Code session |
| Unattended | Yes (fully headless) | No (requires active Claude Code session) |
| Auth | `ANTHROPIC_API_KEY` env var | Operator's Claude Code auth |
| Concurrency | Multiple workers (bounded by `maxConcurrent`) | Sequential (one Agent call at a time) |

The inline path is the preferred mode for dogfood (subscription billing, same
session). The API-key path is the fallback for CI / unattended operation.

---

## Relation to `/ai-sdlc execute`

`/ai-sdlc execute <task-id>` is the **direct dispatch** path: it runs a single
task end-to-end (Steps 0-13) inline in the operator's session.

`/ai-sdlc orchestrator-tick` is the **autonomous loop** path: it reads the
frontier, picks the next task(s), and dispatches them through the
`ClaudeCliInlineSpawner` manifest protocol. The orchestrator drives which task
to run; the operator doesn't specify a task ID.

Both paths ultimately invoke the same `Agent` tool calls to the same developer/
reviewer subagents — the difference is in how the task is selected and how the
loop control works.

---

## References

- `pipeline-cli/src/runtime/spawners/claude-cli-inline.ts` — manifest producer
- `pipeline-cli/src/runtime/spawners/dispatch-result.ts` — bridge helpers
- `ai-sdlc-plugin/commands/orchestrator-tick.md` — slash command body
- `docs/operations/claude-cli-spawner.md` — full design evaluation (Options 1-4)
- `docs/operations/orchestrator-promotion.md` — soak corpus + promotion runbook
- `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md` — design RFC
