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
- `--spawner claude` — `ShellClaudePSpawner`, shells out to `claude -p` (default for `cli-orchestrator tick` since AISDLC-352).
- `--spawner codex` — `CodexHarnessAdapter`, requires `CODEX_SPAWN_AGENT_BIN`.
- `dispatch-result.json` consumer-bridge helpers (`writeDispatchResult` / `readDispatchResult` / `cli-orchestrator tick --continue-from-result`). The result-file half of the AISDLC-225 protocol is retained because the `/ai-sdlc orchestrator-tick` slash command body still uses `write-dispatch-result` for its Agent dispatches.

## What you'll see if you still pass `--spawner claude-cli`

### From the CLI

`yargs` rejects the value at parse time because the `choices: SPAWNER_KINDS`
constraint no longer lists `claude-cli`:

```
$ cli-orchestrator tick --spawner claude-cli
cli-orchestrator tick: Invalid values:
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
For autonomous parallel drain, use the Dispatch Board model:
  /ai-sdlc orchestrator-tick    (Conductor) + /ai-sdlc dispatch-worker (Worker sessions)
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

### Cron / daemon / sidecar driving `cli-orchestrator tick` from a plain shell

Drop the `--spawner claude-cli` flag — `claude` (subscription billing via
`claude -p`) has been the default for `cli-orchestrator tick` since AISDLC-352:

```bash
# Before
cli-orchestrator tick --spawner claude-cli

# After
cli-orchestrator tick                        # implicit --spawner claude
# OR equivalently:
cli-orchestrator tick --spawner claude
```

If you previously relied on the inline-manifest path because the
sidecar runs inside a Claude Code session, that path is now gone. Open a CC
session and run `/ai-sdlc orchestrator-tick` (Conductor) plus one or more
`/ai-sdlc dispatch-worker` sessions (Workers) — see the Dispatch Board model
below.

### Operator-driven autonomous drain (slash command body path)

Use the Dispatch Board model (RFC-0041 Conductor/Worker architecture, shipped
in AISDLC-377.1/2/3):

1. **Conductor**: open one CC session and run `/ai-sdlc orchestrator-tick`. It
   loops via `ScheduleWakeup(30s)`, polls the backlog frontier, and writes
   `queue/<task-id>.dispatch.json` manifests to the Dispatch Board.
2. **Workers**: open N additional CC sessions and run
   `/ai-sdlc dispatch-worker` in each. Each Worker claims a manifest from the
   board, dispatches a foreground `Agent(developer)`, and writes the verdict
   back to `done/<task-id>.verdict.json` for the Conductor to pick up.
3. **Reviewers** are fanned out by the Conductor as foreground `Agent` calls
   against the verdict's PR (cheap; short-lived).

N CC sessions = N-wide parallelism at **zero incremental cost** beyond the
operator's existing Claude Code Max subscription.

For headless / CI contexts where no operator CC session is available, use the
supervisor path: `cli-dispatch-supervisor` spawns `env -u CLAUDECODE claude -p`
subprocess Workers with operator-controlled 30 min watchdogs. See
[`dispatch-supervisor-install.md`](./dispatch-supervisor-install.md).

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
still work for the `cli-orchestrator tick --continue-from-result <path>` flow —
your consumer can write a `DispatchResult` directly without going through a
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

## Implementation note — AC #5

AISDLC-377.6 AC #5 reads "No `Agent(... run_in_background: true)` calls remain
in the dispatch hot path (grep test in CI)". This AC was authored before
RFC-0041's Pattern X v2 (AISDLC-396) shipped — Pattern X v2's
`/ai-sdlc orchestrator-tick` Step 2.5 Phase B explicitly uses
`run_in_background: true` as its core developer-dispatch mechanism (see
`ai-sdlc-plugin/commands/orchestrator-tick.md` lines 75-118).

The reconciled reading: AC #5 is scoped to the **legacy claude-cli dispatch hot
path** — i.e., no orphaned `Agent(... run_in_background)` calls remain from the
deleted inline-manifest path. The `Agent(... run_in_background)` usages
remaining in `orchestrator-tick.md` are Pattern X v2's intentional design (Bash
slash command bodies cannot register completion callbacks, so the dispatch +
reconcile must span ticks via `bg-agent-pending/<task-id>.json` sentinels).
This interpretation was flagged in the AISDLC-377.6 PR body for operator
sign-off; the grep test in CI was not added because adding it would break
Pattern X v2's documented design.

## See also

- [`docs/operations/operator-runbook.md`](./operator-runbook.md) — full operator playbook for the Conductor/Worker model
- [`docs/operations/billing-and-cost-optimization.md`](./billing-and-cost-optimization.md) — billing model breakdown across spawners
- [`pipeline-cli/docs/spawner.md`](../../pipeline-cli/docs/spawner.md) — engineer-facing SubagentSpawner reference
- [`spec/rfcs/RFC-0041-conductor-worker-process-architecture.md`](../../spec/rfcs/RFC-0041-conductor-worker-process-architecture.md) — architecture reference
