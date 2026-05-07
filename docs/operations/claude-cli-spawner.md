# Claude CLI Spawner — Design Evaluation and Option 3 Implementation

**Status**: Implemented (Option 3 — Co-located process / inline orchestrator)
**Task**: AISDLC-198
**RFC**: RFC-0015 §8.2 follow-up

---

## Why this document exists

The autonomous pipeline orchestrator (RFC-0015, `cli-orchestrator`) can run in
two billing modes:

| Mode | Spawner | Cost model |
|---|---|---|
| API-key | `--spawner api-key` | Per-token Anthropic API credits |
| Subscription | `--spawner claude-cli` | Flat Claude Code Max subscription |

As of AISDLC-182, `--spawner claude-cli` was stubbed with a
`not-yet-implemented` error because the cross-session dispatch problem was
unsolved: the orchestrator runs as a CLI process, but subagent invocations via
the `Agent` tool are only available INSIDE an active Claude Code session.

This doc evaluates four paths and records the rationale for shipping Option 3.

---

## Option 1 — Out-of-band queue (poll pattern)

**Mechanism**: The orchestrator (or `execute` subcommand) writes each dispatch
request as a JSON line to a queue file (e.g.
`$ARTIFACTS_DIR/_orchestrator/dispatch.jsonl`). The operator's Claude Code
session runs `/ai-sdlc poll` (a new slash command) that reads the queue and
invokes the `Agent` tool for each pending item.

**Pros**:
- Asynchronous — orchestrator and Claude Code session are decoupled.
- Operator can batch-review the queue before approving dispatches.
- No new long-lived process required.

**Cons**:
- Adds operator latency: the poll period (or manual `/ai-sdlc poll` invocations)
  introduces a gap between "orchestrator decides to dispatch" and "subagent
  actually starts".
- Requires the operator to remember to run `/ai-sdlc poll` (or set up a
  `/schedule` cron, which has read-only restrictions — see CLAUDE.md remote
  agents section).
- The dispatch queue may grow unbounded if the operator is away; resuming after
  a long absence requires auditing the entire queue.
- Two-file protocol (queue + ack) is needed to prevent double-dispatch;
  adds complexity and failure modes.

**Assessment**: Viable follow-up implementation. Ships autonomy at the cost of
latency and a polling step. Better suited for a "batch approve then dispatch"
workflow than a "continuous autonomous loop".

---

## Option 2 — MCP server bridge

**Mechanism**: The `claude-cli` spawner is backed by an MCP tool (new tool in
the `ai-sdlc-plugin` MCP server). When the orchestrator calls
`spawner.spawn(opts)`, the spawner calls the MCP tool, which bridges back into
the operator's Claude Code session to invoke the `Agent` tool.

**Pros**:
- Clean separation: spawner protocol is unchanged; MCP is the transport.
- Could support multiple concurrent sessions with load-balancing.

**Cons**:
- Requires the operator's Claude Code session to have the MCP client connected
  to the plugin MCP server (already required for most workflows, but brittle
  if the session restarts).
- MCP server bridging to Agent tool calls is not a supported Anthropic pattern.
  The MCP server would need to re-enter the operator's session via a side-channel
  (e.g. IPC socket), which is not a stable API.
- Adds a new MCP tool that would be invoked from outside Claude Code — effectively
  remote execution through the plugin, which conflicts with the remote-agents
  read-only design rule (CLAUDE.md: "Remote agents (`/schedule`) — read-only
  by design").
- The plugin's MCP server cannot itself call the `Agent` tool (verified by
  AISDLC-69.2: plugin subagents one level deep cannot use Agent).

**Assessment**: Not viable without unsupported Anthropic SDK changes. Defer.

---

## Option 3 — Co-located process / inline orchestrator (SELECTED)

**Mechanism**: The orchestrator does NOT run as a separate long-lived process.
Instead, the operator's Claude Code session IS the orchestrator process. A slash
command (e.g. `/ai-sdlc execute <task-id>` or a new `/loop` variant) runs the
orchestrator tick loop inline, calling the `Agent` tool directly to dispatch
subagents. Between ticks it uses `ScheduleWakeup` to yield control back to the
session without blocking.

This is the formalization of the already-proven pattern:

```
/loop /ai-sdlc execute <task-id>
```

The "spawner" in Option 3 does NOT call a subprocess. Instead, it produces a
**dispatch manifest** — a JSON descriptor of the Agent call the slash command
body should make — and emits it to:

```
$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json
```

The orchestrator tick loop, when `--spawner claude-cli` is set, emits the
manifest instead of calling `executePipeline()` directly. The calling slash
command body reads the manifest and invokes the `Agent` tool.

**Pros**:
- Uses the operator's existing subscription billing — same billing path as
  `/ai-sdlc execute <task-id>` today.
- No new IPC, sockets, or polling. The manifest is just a JSON file that the
  slash command body writes and reads within the same tick.
- Aligns with the existing `/loop + ScheduleWakeup` pattern that has shipped
  16+ PRs in a single session (2026-05-04 dogfood evidence).
- The spawner code is deterministically testable: it produces a manifest,
  which is a pure data type with no subprocess or network side-effects.
- The dispatch manifest is also an observability artifact: operators can inspect
  `dispatch-manifest.json` between ticks to see what the orchestrator is doing.
- The orchestrator's filter chain, rollback wiring, and events.jsonl bus are
  all preserved — the only change is how the dispatched subagent is invoked.

**Cons**:
- Requires the operator to be in a Claude Code session (not fully unattended).
  This is acceptable for the current dogfood stage: "autonomous" here means
  "operator doesn't have to manually type each task-id, just leave the session
  running".
- ScheduleWakeup between ticks means the session uses some compute (vs. a
  sleeping CLI process). Acceptable for Max-20x plan.
- Not horizontally scalable (single session = single worker thread). Option 1
  or 2 would be needed for multi-session dispatch. Phase 2 follow-up.

**Assessment**: Ships the highest-value path (subscription billing, proven
pattern, no new IPC) with lowest complexity. Selected for AISDLC-198.

---

## Option 4 — Claude Code SDK extension

**Mechanism**: Anthropic extends the `@anthropic-ai/claude-code` SDK with a
cross-session `Agent` invocation API so an out-of-process caller can dispatch
subagents into an existing Claude Code session.

**Pros**:
- Would be the "clean" long-term API if supported.

**Cons**:
- Requires changes to the Anthropic SDK — not in scope for the project and
  not currently on any public roadmap.
- Long delivery path; the project needs autonomous dispatch now.

**Assessment**: Deferred indefinitely. Revisit if Anthropic ships a cross-session
Agent API.

---

## Summary recommendation

| Option | Status | Reason |
|---|---|---|
| 1 (queue) | Future follow-up | Viable but adds latency + polling complexity |
| 2 (MCP bridge) | Deferred | MCP → Agent bridge not supported |
| 3 (inline) | **Shipped (AISDLC-198)** | Proven pattern, subscription billing, simplest |
| 4 (SDK extension) | Deferred indefinitely | Requires Anthropic SDK changes |

---

## Implementation: Option 3 (inline mode)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Operator's Claude Code session                               │
│                                                             │
│  /ai-sdlc start-orchestrator                                │
│  │                                                          │
│  └──> tick loop (inline, ScheduleWakeup between ticks)      │
│        │                                                     │
│        ├── read frontier (cli-deps / in-process graph)      │
│        ├── run admission filters                             │
│        ├── for each admitted task:                           │
│        │     ClaudeCliInlineSpawner.buildManifest(opts)     │
│        │     → write dispatch-manifest.json                  │
│        │     → Agent tool call (developer subagent)          │
│        │     ← read subagent JSON return                     │
│        │     → continue pipeline steps (review, push, PR)   │
│        └── ScheduleWakeup(tickIntervalSec)                  │
└─────────────────────────────────────────────────────────────┘
```

### Key files

| File | Role |
|---|---|
| `pipeline-cli/src/runtime/spawners/claude-cli-inline.ts` | Spawner that produces dispatch manifests |
| `pipeline-cli/src/cli/execute.ts` | Updated `CLAUDE_CLI_SPAWNER_DEFERRED_MESSAGE` and `resolveSpawner` |
| `docs/operations/orchestrator-runbook.md` | Operator runbook entry for inline mode |

### Dispatch manifest shape

```json
{
  "version": 1,
  "taskId": "AISDLC-123",
  "subagentType": "developer",
  "model": "claude-sonnet-4-6",
  "prompt": "...",
  "cwd": "/path/to/worktree",
  "runInBackground": false,
  "emittedAt": "2026-05-05T00:00:00.000Z"
}
```

The manifest is written atomically to
`$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json`. The calling slash
command body reads the manifest after the spawner returns and invokes the
`Agent` tool with the described parameters.

### How `--spawner claude-cli` works in the inline path

1. The slash command body starts the orchestrator with `--spawner claude-cli`.
2. The orchestrator's `resolveSpawner('claude-cli')` returns a
   `ClaudeCliInlineSpawner` instance.
3. On `spawn(opts)`, the spawner writes the manifest and returns a
   `SubagentResult` with `status: 'manifest-emitted'` — a new status value
   indicating "the caller (slash command body) must invoke the Agent tool".
4. The slash command body checks `result.status === 'manifest-emitted'` and
   reads `dispatch-manifest.json` to get the Agent call parameters.
5. The slash command body invokes `Agent(manifest.subagentType, manifest.prompt)`.
6. The slash command body converts the Agent result back into a
   `SubagentResult` and continues the pipeline.

This round-trip keeps the pipeline-cli orchestrator code pure (no Agent tool
calls in TypeScript land — those live in the slash command body only) while
letting the inline mode drive the dispatch.

### Consumer bridge — production-ready (AISDLC-225)

Step 6 above (converting the Agent result back into a `SubagentResult`) is
implemented by the `/ai-sdlc orchestrator-tick` slash command (AISDLC-225).
The bridge protocol uses a second well-known file:

```
$ARTIFACTS_DIR/_orchestrator/dispatch-result.json
```

After the Agent call, the slash command body writes the result to this file
using `writeDispatchResult()` from `pipeline-cli/src/runtime/spawners/dispatch-result.ts`.
The orchestrator tick loop reads it via `readDispatchResult()` and converts it
back to a `SubagentResult` via `dispatchResultToSubagentResult()`.

**Full round-trip:**

```
ClaudeCliInlineSpawner.spawn()
  → writes dispatch-manifest.json
  → returns { status: 'manifest-emitted' }

/ai-sdlc orchestrator-tick (slash command body)
  → reads dispatch-manifest.json
  → invokes Agent tool
  → writes dispatch-result.json

cli-orchestrator tick --continue-from-result
  → reads dispatch-result.json
  → dispatchResultToSubagentResult()
  → continues executePipeline() Steps 6+
```

See [`docs/operations/orchestrator-inline-loop.md`](./orchestrator-inline-loop.md)
for the complete consumer protocol documentation.

---

## Running the inline orchestrator

See the [Consumer Bridge Protocol](./orchestrator-inline-loop.md) for the
step-by-step start procedure and loop control options.

For background on the operator runbook, see
[orchestrator-runbook.md](./orchestrator-runbook.md#inline-orchestrator-mode-claude-cli-spawner).
