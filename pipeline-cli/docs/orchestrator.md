# Autonomous Pipeline Orchestrator — operator guide (RFC-0015 Phase 1)

> **Status:** experimental, opt-in via `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`.
> Phase 1 ships the bare polling loop only. Failure-recovery playbook (Phase 2),
> pre-dispatch admission filters (Phase 3), and `events.jsonl` writer +
> `cli-status --orchestrator` (Phase 4) land in subsequent tasks
> (AISDLC-169.2 / .3 / .4).

The orchestrator is a long-running Node process that ties RFC-0010 (parallel
execution), RFC-0011 (DoR gate), RFC-0012 (`executePipeline()`), RFC-0014
(dependency-graph composition), and AISDLC-117 (`cli-deps`) into a single
unattended driver. Per RFC-0015 §13 Q11 the harness is a pure Node process —
zero subscription cost while idle, simplest mental model, no CI infra
to maintain.

## Quick start

```bash
# 1. Opt in (the loop refuses to start otherwise).
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental

# 2. (Optional) Turn on the dependency-graph composition layer so the
# frontier sorts by effectivePriority DESC → criticalPathLength DESC →
# recency DESC instead of plain id ASC.
export AI_SDLC_DEPS_COMPOSITION=on

# 3. Inspect what the orchestrator will pick up next.
node pipeline-cli/bin/cli-orchestrator.mjs status

# 4. Drive a single tick (good for cron / sanity checks).
node pipeline-cli/bin/cli-orchestrator.mjs tick

# 5. Run the polling loop in the foreground (operator supervises via
# terminal, systemd, Docker restart-policy, or a self-hosted GH Actions runner).
node pipeline-cli/bin/cli-orchestrator.mjs start
```

Stop the loop with Ctrl-C (SIGINT) or `kill -TERM <pid>`. Per RFC-0015 §13 Q2
there's no resume state to corrupt — the next `start` re-derives everything
from the frontier + git + gh, so a hard kill is recoverable too.

> **Invocation pattern (AISDLC-156):** always invoke the bin shim DIRECTLY
> via `node pipeline-cli/bin/cli-orchestrator.mjs`. NEVER use
> `pnpm --filter @ai-sdlc/pipeline-cli exec cli-orchestrator` — `pnpm exec`
> does not resolve a workspace package's own bins and will silently fail.

## Subcommands

### `start` — run the polling loop

```text
node pipeline-cli/bin/cli-orchestrator.mjs start \
  [--tick-interval-sec <N>] \
  [--max-concurrent <N>] \
  [--max-ticks <N>] \
  [--work-dir <path>]
```

| Flag | Default | Notes |
|---|---|---|
| `--tick-interval-sec` | `30` | Polling cadence between ticks. Phase 3 will plug in the exponential-backoff curve for empty/peak-blocked windows. |
| `--max-concurrent` | `1` | Phase 1 default is single-worker per RFC-0015 §11. Phase 2+ raises it once the failure playbook is in place. |
| `--max-ticks` | `null` (forever) | Cap on tick count. `--max-ticks 1` makes `start` equivalent to `tick`. Tests + cron-style supervisors set a finite value. |
| `--work-dir` | `cwd` | Project root. Same convention as `cli-deps`. |

Each tick:

1. Reads the frontier in-process via the same query `cli-deps frontier` runs.
   When `AI_SDLC_DEPS_COMPOSITION` is on, the result is already sorted by
   `effectivePriority DESC → criticalPathLength DESC → recency DESC`
   (RFC-0014 §12 Q1). When off, the frontier is in `id ASC` order.
2. Picks the first `maxConcurrent` candidates.
3. Dispatches each via `executePipeline()` (RFC-0012 Tier 2). The default
   spawner resolves to `ShellClaudePSpawner` (subscription) or
   `ClaudeCodeSDKSpawner` (API key) per `defaultSpawner()`.
4. Records each outcome. If a dispatch throws OR returns
   `outcome: 'needs-human-attention'`, the orchestrator labels the
   associated PR (when one exists) with `needs-human-attention` via
   `gh pr edit --add-label`. Phase 1 records the escalation in the in-memory
   tick result; Phase 4 plumbs it into `events.jsonl`.
5. Sleeps `tickIntervalSec` and loops.

Exit: `0` on a clean drain (SIGINT/SIGTERM caught between ticks), `2` when
the feature flag is off (refused to start), `1` on any other error.

### `tick` — run one tick + exit

```text
node pipeline-cli/bin/cli-orchestrator.mjs tick \
  [--dry-run] \
  [--tick-interval-sec <N>] \
  [--max-concurrent <N>] \
  [--work-dir <path>]
```

Useful for:
- Cron-driven supervisors that prefer "every 30s, run a tick" over a
  long-lived daemon.
- One-shot smoke testing during operator rollout.
- CI jobs that want to dispatch one task per workflow run.

`--dry-run` resolves the frontier + reports candidate count, but never
calls `executePipeline()` — handy when you want to see WHAT the next tick
would dispatch without committing to it.

### `status` — inspect the frontier (read-only)

```text
node pipeline-cli/bin/cli-orchestrator.mjs status [--work-dir <path>]
```

Returns JSON of the form:

```jsonc
{
  "ok": true,
  "mode": "status",
  "flag": "AI_SDLC_AUTONOMOUS_ORCHESTRATOR",
  "status": {
    "frontier": [{ "id": "AISDLC-169.2", "title": "Phase 2: Failure playbook" }, ...],
    "queueDepth": 5,
    "lastTick": null,
    "config": { "tickIntervalSec": 30, "maxConcurrent": 1, ... },
    "enabled": true
  }
}
```

`status` does NOT require the feature flag — it's a read-only inspection
surface so operators can preview what the loop would pick up before turning
the flag on.

## Idempotent finalize (RFC-0015 §13 Q2)

Phase 1 inherits `executePipeline()`'s finalize sequence (Steps 10–13). Each
step in that sequence already short-circuits when its work is already done —
this is what makes "stateless + idempotent finalize" work without a
resume-from-state code path:

| Step | "Already done?" predicate |
|---|---|
| **Step 10 — finalize-task** | `task.status === 'Done'` AND task file already in `backlog/completed/` → no-op the file move; AC checkboxes already `[x]` → no-op the patch; `finalSummary` section already present → no-op the append. |
| **Step 10 — attestation sign** | `.ai-sdlc/attestations/<sha>.dsse.json` already exists for HEAD → no-op the sign. |
| **Step 10 — chore commit** | HEAD's commit message already starts with `chore(<scope>): finalize <task-id>` → no-op the commit. |
| **Step 11 — push** | `git ls-remote origin <branch>` already returns the local HEAD SHA → no-op the push. (`git push` itself is also a natural no-op on "already up to date"; we surface a structured success regardless.) |
| **Step 11 — `gh pr create`** | `gh pr list --head <branch>` already returns a row → re-use the existing PR URL instead of opening a duplicate. |
| **Step 12 — sibling PRs** | Same `gh pr list --head <branch>` predicate per sibling repo. |
| **Step 13 — cleanup** | `<worktree>/.active-task` already absent → no-op the delete. |

A crashed-mid-finalize worker is therefore picked up on the next tick: the
new orchestrator runs the same finalize sequence and each step short-circuits
where appropriate. **No resume code path; startup IS the recovery path.**

## Auto-merge orchestrator-side (RFC-0015 §13 Q12)

Per RFC §13 Q12 resolution, defense-in-depth ships in two layers:

- **Workflow side (already shipped via AISDLC-130):**
  `auto-enable-auto-merge.yml` extended its trigger to
  `[opened, synchronize, reopened]` so re-pushed PRs re-acquire the
  auto-merge flag automatically.
- **Orchestrator side (Phase 1 to-do):** the finalize sequence ends with
  `gh pr merge --auto --rebase <pr>` (idempotent — `gh` no-ops if the flag
  is already set) and emits `AutoMergeFlagSet` to `events.jsonl`.

> Phase 1 currently relies on the workflow side; the orchestrator-side
> `gh pr merge --auto --rebase` call lands as a finalize-step extension in
> Phase 2 alongside the catalogued failure-recovery handlers.
> Setting the auto-merge flag is NOT the same as merging — see CLAUDE.md
> "Setting --auto is NOT merging" + RFC §13 Q12 nuance.

## Failure handling (Phase 1 = bare)

Phase 1 has **no catalogued failure-recovery handlers**. Every failure that
escapes `executePipeline()`'s native iteration loop is treated as an
`UnknownFailureMode` per RFC §13 Q8:

1. The exception (or the `outcome: 'needs-human-attention'` return value)
   is captured in the tick result.
2. The escalation hook tags the associated PR with `needs-human-attention`
   via `gh pr edit --add-label`. Tasks that failed BEFORE any push happened
   are recorded with `prUrl: null`.
3. The loop continues to the next tick — a single bad task NEVER crashes
   the orchestrator.

Phase 2 (AISDLC-169.2) ships the 9-pattern catalogue from RFC §5.1 +
the `.ai-sdlc/orchestrator-failure-patterns.yaml` source-of-truth (RFC §13
Q9). Phase 4 (AISDLC-169.4) replaces the in-memory escalation array with
the canonical `events.jsonl` bus.

## Supervision templates

Phase 1 ships placeholders for the three supervision modes RFC §13 Q11
called out (systemd unit, Docker container, GH Actions self-hosted runner).
A reference systemd unit looks like:

```ini
# /etc/systemd/system/ai-sdlc-orchestrator.service
[Unit]
Description=AI-SDLC Autonomous Pipeline Orchestrator (RFC-0015)
After=network.target

[Service]
Type=simple
User=ai-sdlc
WorkingDirectory=/srv/ai-sdlc
Environment=AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
Environment=AI_SDLC_DEPS_COMPOSITION=on
ExecStart=/usr/bin/node /srv/ai-sdlc/pipeline-cli/bin/cli-orchestrator.mjs start
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

Docker template (Dockerfile excerpt):

```dockerfile
FROM node:22-alpine
WORKDIR /srv/ai-sdlc
RUN apk add --no-cache git github-cli
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
ENV AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
CMD ["node", "pipeline-cli/bin/cli-orchestrator.mjs", "start"]
```

GH Actions self-hosted runner — deploy the same image as a long-running
runner pointed at the project repo.

> Phase 1 keeps these as documented examples rather than committed template
> files because the right shape varies per operator (systemd vs OpenRC,
> Alpine vs Debian, sidecar vs primary container, etc.). Operators who need
> a committed template are encouraged to PR one against
> `pipeline-cli/docs/orchestrator-templates/` once a recurring pattern
> emerges.

## Programmatic API

Same surface, importable from `@ai-sdlc/pipeline-cli/orchestrator`:

```ts
import {
  defaultOrchestratorConfig,
  runOrchestratorLoop,
  runOrchestratorTick,
  buildOrchestratorStatus,
} from '@ai-sdlc/pipeline-cli/orchestrator';

// One tick, custom adapters (e.g. injected MockSpawner for tests):
const tick = await runOrchestratorTick(
  defaultOrchestratorConfig({ workDir: '/srv/ai-sdlc', maxConcurrent: 2 }),
  {
    /* dispatch?, frontier?, escalate?, sleep?, logger?, spawner?, runner? */
  },
  /* tickNumber */ 1,
);

// Foreground long-running loop (refuses to start without the flag):
await runOrchestratorLoop(
  defaultOrchestratorConfig({ workDir: '/srv/ai-sdlc', maxConcurrent: 1 }),
  { /* adapters as needed */ },
);
```

## Phase plan

| Phase | Task | Scope |
|---|---|---|
| 1 (this) | AISDLC-169.1 | Bare polling loop, feature flag, escalation hook, `cli-orchestrator` CLI, idempotent-finalize doc. |
| 2 | AISDLC-169.2 | 9-pattern failure playbook + `.ai-sdlc/orchestrator-failure-patterns.yaml` source-of-truth. |
| 3 | AISDLC-169.3 | DoR + dependency + external-deps pre-dispatch admission filters; exponential-backoff cadence. |
| 4 | AISDLC-169.4 | `events.jsonl` writer + `cli-status --orchestrator` view. |
| 5 | AISDLC-169.5 | Real-issue corpus, chaos test (kill mid-tick + verify resume), promotion runbook. |

## Cross-references

- [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md) — full RFC including §13 open-question resolutions.
- [`pipeline-cli/docs/spawner.md`](./spawner.md) — picking the right `SubagentSpawner` for your environment.
- [`pipeline-cli/docs/dependency-graph.md`](./dependency-graph.md) — the cli-deps frontier query the orchestrator drives.
- [`docs/operations/deps-composition.md`](../../docs/operations/deps-composition.md) — RFC-0014 composition layer + `AI_SDLC_DEPS_COMPOSITION`.
