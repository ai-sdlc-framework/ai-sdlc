# `--spawner claude-cli` — removal & migration breadcrumb

> **Status**: removed in RFC-0041 Phase 3.3 (AISDLC-377.6).
> **History**: shipped AISDLC-198 (Option 3 inline-orchestrator pattern). Deprecated AISDLC-377.4 (one-release warning window). Removed here.
> **Audience**: operators with cron entries / shell aliases / CI steps that
> still pass `--spawner claude-cli`, and anyone who lands on a stale link to
> `docs/operations/claude-cli-spawner.md` or
> `docs/operations/orchestrator-inline-loop.md`.

---

## What was removed

| Surface | Status |
|---|---|
| `pipeline-cli/src/runtime/spawners/claude-cli-inline.ts` (the `ClaudeCliInlineSpawner` source) | Deleted |
| `pipeline-cli/src/runtime/spawners/claude-cli-inline.test.ts` (co-located tests) | Deleted |
| `pipeline-cli/src/orchestrator/deprecation-warnings.{ts,test.ts}` (the AISDLC-377.4 stderr warning) | Deleted |
| `docs/operations/claude-cli-spawner.md` (design doc) | Deleted |
| `docs/operations/orchestrator-inline-loop.md` (consumer bridge protocol) | Deleted |
| `'claude-cli'` member of `SpawnerKind` / `SPAWNER_KINDS` in `pipeline-cli/src/cli/execute.ts` | Removed |
| `case 'claude-cli'` branch in `resolveSpawner()` | Replaced with a defense-in-depth `throw CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE` |
| `claude-cli` arm of `resolveEnvUmbrellaSpawnerKind()` (`AI_SDLC_ORCHESTRATOR_SPAWNER=claude-cli`) | Removed (now throws a pointed migration error) |
| `claude-cli` retry guard in `buildDefaultUmbrellaDispatch()` (`AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key`) | Removed — the env var still triggers `FALLBACK_BILLING_WARNING` but no retry fires |

## What still works unchanged

- `--spawner mock` — plumbing-only dry-run.
- `--spawner api-key` — `ClaudeCodeSDKSpawner`, requires `ANTHROPIC_API_KEY`.
- `--spawner claude` — `ShellClaudePSpawner`, shells out to `claude -p` (the default since AISDLC-352).
- `--spawner codex` — `CodexHarnessAdapter`, requires `CODEX_SPAWN_AGENT_BIN`.
- `dispatch-result.json` consumer-bridge helpers (`writeDispatchResult` / `readDispatchResult`). The tick command that consumed them is retired (AISDLC-763).

## What you'll see if you still pass `--spawner claude-cli`

### From the CLI

`yargs` rejects the value at parse time because the `choices: SPAWNER_KINDS`
constraint no longer lists `claude-cli`:

```
$ ai-sdlc-pipeline execute <task> --run --spawner claude-cli
Invalid values:
  Argument: spawner, Given: "claude-cli", Choices: "mock", "api-key", "claude", "codex"
```

### From programmatic callers

`resolveSpawner()` keeps a defense-in-depth check that catches callers who
bypass yargs and pass the string literal:

```
Error: The `claude-cli` spawner was removed in RFC-0041 Phase 3.3 (AISDLC-377.6).
Migrate to one of the supported spawner kinds:
  --spawner claude              (default; subscription billing via `claude -p`)
  --spawner api-key             (ANTHROPIC_API_KEY required)
  --spawner codex               (Codex CLI host-bridge dispatch)
For autonomous parallel drain, use `cli-hierarchy up`.
Migration guide: docs/operations/claude-cli-spawner-removed.md
```

### From an env-driven shell context

`AI_SDLC_ORCHESTRATOR_SPAWNER=claude-cli` is rejected at startup by
`resolveEnvUmbrellaSpawnerKind()`:

```
AI_SDLC_ORCHESTRATOR_SPAWNER=claude-cli is no longer supported. The `claude-cli`
inline-manifest spawner was removed in RFC-0041 Phase 3.3 (AISDLC-377.6). Set
AI_SDLC_ORCHESTRATOR_SPAWNER=claude (default), api-key, or codex, or unset it.
See docs/operations/claude-cli-spawner-removed.md.
```

## How to migrate

### Scripts passing `--spawner claude-cli`

Drop the `--spawner claude-cli` flag. `claude` (subscription billing via `claude -p`) has been the default spawner since AISDLC-352.

### Operator-driven autonomous drain

Use `cli-hierarchy up` ([`cli-hierarchy.md`](./cli-hierarchy.md)): a planner, a dispatch session and executors. The earlier Conductor and Worker slash commands (orchestrator-tick, dispatch-worker) are retired (AISDLC-763).

### Programmatic callers (custom dispatchers, integration scripts)

Replace the import + constructor:

```ts
// Before
import { ClaudeCliInlineSpawner } from '@ai-sdlc/pipeline-cli';
const spawner = new ClaudeCliInlineSpawner({ taskId: 'AISDLC-X' });

// After (subscription billing — shells out to `claude -p`)
import { ShellClaudePSpawner } from '@ai-sdlc/pipeline-cli';
const spawner = new ShellClaudePSpawner();
```

If you were consuming the `'manifest-emitted'` SubagentResult status to gate
work in your own consumer bridge, that protocol is gone. The retained
`dispatch-result.json` helpers (`writeDispatchResult` / `readDispatchResult`)
still work — your consumer can write a `DispatchResult` directly without going through a
manifest-producing spawner.

## Why this was removed

RFC-0041 (Conductor/Worker Process Architecture) replaced the inline-manifest
path with a richer Dispatch Board model that:

- Decouples parallelism from a single CC session — operators run N Workers in
  N sessions, no shared-CC-session contention.
- Separates Conductor (frontier + admission + reviewer fan-out) from Worker
  (developer dispatch) responsibilities so each can iterate independently.
- Provides a durable filesystem-backed handoff (`queue/`, `inflight/`, `done/`,
  `failed/`) that survives session exits, supports stale-heartbeat sweeps, and
  gives operators inspectable per-task state without bespoke tooling.

The inline-manifest path served its purpose during the Phase 1 / Phase 2
orchestrator bring-up (AISDLC-198 / AISDLC-225) but became redundant once the
Dispatch Board landed.

## Implementation note: AC #5

AISDLC-377.6 AC #5 (no `Agent(... run_in_background)` calls in the dispatch hot path) was scoped to the removed claude-cli path. The background-dispatch command bodies that still used it have since been retired (AISDLC-763).

## See also

- [`docs/operations/cli-hierarchy.md`](./cli-hierarchy.md) — session hierarchy reference
- [`docs/operations/billing-and-cost-optimization.md`](./billing-and-cost-optimization.md) — billing model breakdown across spawners
- [`pipeline-cli/docs/spawner.md`](../../pipeline-cli/docs/spawner.md) — engineer-facing SubagentSpawner reference
- [`spec/rfcs/RFC-0041-conductor-worker-process-architecture.md`](../../spec/rfcs/RFC-0041-conductor-worker-process-architecture.md) — architecture reference
