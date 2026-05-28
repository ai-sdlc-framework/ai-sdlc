# `--spawner copilot` — GitHub Copilot CLI Operator Runbook

**Status:** Operational. AISDLC-429.1 (design map), AISDLC-429.2
(`CopilotHarnessAdapter` + `--spawner copilot` resolver), and AISDLC-429.3
(orchestrator wiring + operator docs) have shipped. The GitHub Copilot CLI
is now a supported `SubagentSpawner` for `cli-execute` and the
`cli-orchestrator tick` umbrella dispatcher.

**Applies to:** RFC-0012 Step 0-13 execution backed by the **standalone
`copilot` CLI** (GitHub Copilot CLI, GA 2025). It does NOT cover the
`gh copilot suggest` / `gh copilot explain` autocomplete subcommands of
`gh`, which are not coding-agent dispatchers.

**Companion docs:**

- [`docs/operations/copilot-execution-path.md`](./copilot-execution-path.md) — Phase 1 design map: per-step Codex-vs-Copilot deltas. Read this first if you want the architectural context that motivated the adapter.
- [`docs/operations/codex-execution-path.md`](./codex-execution-path.md) — sibling design for `--spawner codex`. The Copilot adapter mirrors the Codex one almost step-for-step; this doc only covers the Copilot-specific deltas.
- [`docs/operations/operator-runbook.md`](./operator-runbook.md) — top-level operator runbook; cross-links here from the Execution Path References table.
- [`pipeline-cli/README.md`](../../pipeline-cli/README.md) `#--spawner-options` — the canonical `SpawnerKind` table.

---

## Install path

1. **Install the standalone `copilot` CLI** (NOT `gh copilot`). Authenticate with the GitHub account whose Copilot subscription you want billed for dispatch.
2. **Write a bridge script** — a small wrapper that reads the adapter's JSON-line request from STDIN, invokes the `copilot` CLI, and writes the response envelope to STDOUT. The protocol is intentionally minimal so any host can implement it. See the wire format below.
3. **Set `COPILOT_SPAWN_AGENT_BIN`** to the absolute path of your bridge script. The CLI resolver reads this env var when `--spawner copilot` is selected and throws a configuration error before any pipeline mutation if the var is unset.

Programmatic callers can skip the env var entirely and construct
`CopilotHarnessAdapter` directly with their own `CopilotSpawnAgentFn`
injection (e.g. an in-process bridge to Copilot's host tools).

## Wire protocol

The default subprocess bridge (`subprocessCopilotSpawnAgent()` in
`pipeline-cli/src/runtime/spawners/copilot-harness.ts`) speaks a tiny
JSON-line protocol identical in shape to the Codex bridge:

| Direction | Stream | Shape |
|---|---|---|
| Adapter → bridge | `stdin` (single JSON line) | `{ "agentType", "systemPrompt", "userPrompt", "cwd", "timeoutMs" }` |
| Bridge → adapter | `stdout` (single JSON envelope) | `{ "output": string, "parsed"?: unknown }` |
| Bridge → adapter | exit code | `0` for success; non-zero surfaces `stderr` as the error |

The adapter spawns the bridge with `cwd` set to the request's `cwd`
(the worktree). Reviewers are dispatched read-only; the developer agent
needs write access to the worktree.

## Env var override

| Env var | Required | Purpose |
|---|---|---|
| `COPILOT_SPAWN_AGENT_BIN` | **Yes** for `--spawner copilot` (CLI form) | Absolute path to the bridge script. Unset → resolver throws `COPILOT_BRIDGE_MISSING_MESSAGE` before any pipeline mutation. Programmatic constructors can skip this. |
| `AI_SDLC_ORCHESTRATOR_SPAWNER=copilot` | No | Default umbrella spawner kind for `cli-orchestrator tick`. Equivalent to passing `--spawner copilot` on every tick. AISDLC-429.3. |

## Quickstart

### `cli-execute` (one-shot)

```bash
export COPILOT_SPAWN_AGENT_BIN="$(pwd)/scripts/your-copilot-bridge.mjs"
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-NNN --run --spawner copilot
```

### `cli-orchestrator tick` (autonomous umbrella)

```bash
export COPILOT_SPAWN_AGENT_BIN="$(pwd)/scripts/your-copilot-bridge.mjs"
node ./pipeline-cli/bin/cli-orchestrator.mjs tick --spawner copilot
```

Or set the env var so every tick uses Copilot without re-passing the flag:

```bash
export COPILOT_SPAWN_AGENT_BIN="$(pwd)/scripts/your-copilot-bridge.mjs"
export AI_SDLC_ORCHESTRATOR_SPAWNER=copilot
node ./pipeline-cli/bin/cli-orchestrator.mjs tick
```

### Programmatic injection (no bridge, no env var)

```typescript
import { CopilotHarnessAdapter } from '@ai-sdlc/pipeline-cli';

const adapter = new CopilotHarnessAdapter({
  spawnAgent: async ({ agentType, systemPrompt, userPrompt, cwd, timeoutMs }) => {
    // Wrap Copilot's host tool / in-process call here.
    return { output: '<agent JSON return>', parsed: { /* optional pre-parse */ } };
  },
});
```

## Billing safety

The CLI resolver **refuses to silently fall back to `ANTHROPIC_API_KEY`
billing** when `COPILOT_SPAWN_AGENT_BIN` is unset and `--spawner copilot`
was requested. This is a deliberate guardrail: the operator selected the
GitHub Copilot subscription billing model, and a silent fallback to paid
Anthropic API tokens would violate that intent.

If you need to share machines between `--spawner copilot` and
`--spawner api-key` workflows, set `COPILOT_SPAWN_AGENT_BIN` only in the
shell sessions where you want Copilot dispatch. Do NOT export it
globally if you also run `--spawner api-key` from the same shell.

The `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` env var still
**does not** auto-retry a Copilot dispatch on `api-key` — the no-retry
contract that AISDLC-377.6 cemented for the `claude` spawner applies to
every non-`api-key` spawner. The fallback env var is honored only as a
billing-safety warning at tick start; it produces no behavioural retry.

## Known limitations vs. `claude` / `codex`

| Concern | `--spawner claude` | `--spawner codex` | `--spawner copilot` |
|---|---|---|---|
| Bridge required | No (shells out to `claude -p` directly) | Yes (`CODEX_SPAWN_AGENT_BIN`) | Yes (`COPILOT_SPAWN_AGENT_BIN`) |
| Canonical bridge shipped in repo | n/a (uses `claude` on PATH) | Yes (`scripts/codex-spawn-agent-bridge.mjs`, AISDLC-251) | **No** — operators write their own bridge script today. A canonical bridge may ship in a follow-up phase if the pilot validates a stable Copilot CLI invocation grammar. |
| PATH-based auto-fallback | n/a | No | **No** — env var only. The Phase 1 design map left a PATH-based discovery path as a possible future enhancement; Phase 2 shipped env-var-only resolution to keep the billing-safety guarantee simple. |
| Cross-harness reviewer agents shipped | Yes (default) | Yes (AISDLC-247: `code-reviewer-codex`, `test-reviewer-codex`) | **No** — Copilot is currently a developer-side spawner only. Cross-harness review (Claude develops, Copilot reviews) is out of scope for Phase 3 and may land in a follow-up. |
| Pilot validation | Production-ready (default `cli-orchestrator` spawner since AISDLC-352) | Pilot-validated 2026-05-09 (AISDLC-202.4) | **Pilot-pending** — adapter + tests landed in Phase 2 with mocked bridges; no real-CLI end-to-end pilot has run yet. Treat the first real-CLI runs as exploratory and verify reviewer-verdict shapes match the canonical envelope before relying on them. |

## Error messages

When the resolver fails it surfaces one of two messages:

1. **Bridge env var unset** (`COPILOT_BRIDGE_MISSING_MESSAGE` in
   `pipeline-cli/src/runtime/spawners/copilot-harness.ts`):

   > `--spawner copilot` requires COPILOT_SPAWN_AGENT_BIN in the
   > environment (path to a script wrapping Copilot's spawn_agent host
   > tool). Install GitHub Copilot CLI and set COPILOT_SPAWN_AGENT_BIN to
   > the path of your bridge script. For programmatic use, construct
   > CopilotHarnessAdapter directly with a custom CopilotSpawnAgentFn
   > injected.

2. **Bridge exited zero with empty stdout** — the adapter treats this as
   a bridge bug (not as an empty developer JSON envelope) and surfaces
   the failure as a `SubagentResult` error so Step 6's
   `parseDeveloperReturnWithRetry` can retry or escalate cleanly.

In both cases the orchestrator umbrella records the failure as a
`spawner-unavailable` outcome and the AISDLC-177 rollback set fires
before any task mutation lands — matches the Codex contract.

## See also

- [Phase 1 design map](./copilot-execution-path.md) — per-step Codex-vs-Copilot deltas.
- [Phase 2 PR / `CopilotHarnessAdapter` source](../../pipeline-cli/src/runtime/spawners/copilot-harness.ts).
- [`cli/execute.ts` resolver](../../pipeline-cli/src/cli/execute.ts) — the `case 'copilot':` branch.
- [`orchestrator/loop.ts`](../../pipeline-cli/src/orchestrator/loop.ts) `resolveUmbrellaSpawnerKind()` — the AISDLC-429.3 wiring that routes `--spawner copilot` through the umbrella dispatcher.
- [`pipeline-cli/README.md` spawner-options table](../../pipeline-cli/README.md#--spawner-options) — the canonical `SpawnerKind` reference.
