# Autonomous Pipeline Orchestrator — operator guide (RFC-0015 Phases 1+2+4+5)

> **Status:** experimental, opt-in via `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`.
> Phase 1 (AISDLC-169.1) shipped the bare polling loop. Phase 2
> (AISDLC-169.2) adds the catalogued failure playbook described below.
> Phase 4 (AISDLC-169.4) adds the canonical `events.jsonl` writer,
> the `cli-status --orchestrator` view, and the schema for downstream
> consumers. Pre-dispatch admission filters (Phase 3) ship in parallel
> (AISDLC-169.3); the soak corpus aggregator + chaos-test harness +
> promotion runbook (Phase 5) is AISDLC-169.5 and lives below in the
> "Promotion to default-on" section.

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

## Failure handling — Phase 2 catalogued playbook (AISDLC-169.2)

Phase 2 ships the 9-pattern failure playbook from RFC §5.1 + the
versioned source-of-truth at `.ai-sdlc/orchestrator-failure-patterns.yaml`
(RFC §13 Q9). When a dispatch fails, the orchestrator:

1. Builds a `WorkerContext` (failing task ID, branch, worktree path,
   captured stderr/exit-code, etc.).
2. Walks the playbook registry in priority order
   ([`pipeline-cli/src/orchestrator/playbook/registry.ts`](../src/orchestrator/playbook/registry.ts)).
   The first handler whose `detect(ctx)` returns true claims the
   failure.
3. Runs the handler's `remediate(ctx)` up to the catalogue-configured
   `budget` attempts. A successful remediation returns the worker to a
   normal state (`DONE`, `FINALIZING`, `PARKED`) and the tick records
   the recovered outcome.
4. If the budget is exhausted (or `escalateImmediately: true` is set),
   the runner emits `RemediationFailed` + transitions the worker to
   `NEEDS_HUMAN_ATTENTION` (or `PARKED` for `LongRunningPRBlocksWorker`)
   and tags the associated PR via the generic `EscalateFn` (RFC §13 Q1
   layer A — `needs-human-attention` PR label).
5. If no handler claims the failure, the runner falls through to the
   Phase 1 `UnknownFailureMode` catch-all per RFC §13 Q8 (conservative
   bias — operator reviews + extends the catalogue if a recurring
   pattern emerges).

Every state transition emits a `WorkerStateTransition` event with
`{from, to, duration_ms, context}`; per-attempt remediations emit
`RemediationApplied` events; budget-exhaustion emits `RemediationFailed`;
`LongRunningPRBlocksWorker` emits `WorkerParked` instead of a PR label.
Phase 2 surfaces these events in-memory on the tick result's
`playbookEvents` field; Phase 4 (AISDLC-169.4) plumbs them into the
canonical `events.jsonl` bus.

### The 9 catalogued modes

| Mode | Detection | Remediation | Budget | Escalation |
|---|---|---|---|---|
| `SecretScanBlocked` | `git push` rejected with `push declined due to repository rule violations` AND `Secret Scanning` mention in stderr | Re-spawn dev with secret-scan stderr; dev rewrites literal patterns to template-literal construction | 2 | `needs-human-attention` PR label |
| `PushRaceWithMergeQueue` | `git push` rejected with `protected branch hook declined` AND `queued for merging` mention | Sleep 60s + retry push with `--force-with-lease` | 3 | `MergeQueueStuck` advisory + leave commit local |
| `RebaseConflict` | `git rebase` exits non-zero with `<<<<<<< HEAD` markers OR `CONFLICT` phrasing | Invoke `/ai-sdlc rebase` resolver subagent (AISDLC-105) via the redispatch hook | 1 | Per AISDLC-105 escalation: `needs-human-attention` |
| `VerificationFailure` | `pnpm build/test/lint/format` (or `vitest`/`tsc`/`eslint`/`prettier`) exits non-zero with `failed`/`FAIL` phrasing | Re-spawn dev with combined verify stderr feedback | 2 | `needs-human-attention` |
| `ReviewerMajorOrCritical` | Aggregated reviewer verdict has any `critical` or `major` finding (structured `reviewerFindings` field, NOT stderr grep) | Re-spawn dev with combined reviewer feedback | 2 | `needs-human-attention` |
| `EnvHookFailure` | husky pre-commit fails with `tsc not found` / `command not found` / `ENOENT.*executable` phrasing | Retry push with `--no-verify` ONLY when the diff is data-only (`backlog/`, `docs/`, `spec/`, `.ai-sdlc/`, root `*.md`) | 1 | `EnvHookFailed`; source-touching changes refused |
| `AttestationVerifyMismatch` | CI reports `contentHashV3 mismatch` after a sibling PR merged into main | Run `scripts/check-attestation-sign.sh` to re-sign the envelope, then re-push | 1 | `AttestationStaleAfterRebase` advisory |
| `LongRunningPRBlocksWorker` | Worker's PR open + queued for >2h without merge OR rejection (`prAgeMs >= 7,200,000`) | Park worker — release the worktree slot, the PR continues independently | 1 | `WorkerParked` event; PR is NOT labelled (parking is not a defect per RFC §13 Q6) |
| `StackedPRBaseSquashed` | `mergeStateStatus: 'DIRTY'` AND base PR has a `mergedAt` timestamp (squash- or rebase-merged base) | `git fetch origin main` + `git rebase --reapply-cherry-picks origin/main` + `--force-with-lease` push | 1 | Manual review when rebase conflicts |

The catalogue is **operator-overrideable** via
`.ai-sdlc/orchestrator-failure-patterns.yaml` (Q9 + Q7). Per-mode
`budget` and `escalateImmediately` are the two override knobs. The
loader rejects unknown keys + unknown modes with `CatalogueParseError`
so a typo fails loudly at startup instead of silently miscategorising.

### Worker state machine (RFC-0015 §5.2)

```
DEV_RUNNING
  → REVIEW_RUNNING → FINALIZING → DONE
  → ITERATE_DEV (verify_fail / review_changes_requested, budget>0)
  → REMEDIATE_SECRETSCAN | REMEDIATE_PUSH_RACE | REMEDIATE_REBASE
    | REMEDIATE_VERIFICATION | REMEDIATE_REVIEW | REMEDIATE_ENV_HOOK
    | REMEDIATE_ATTESTATION | REMEDIATE_STACKED_PR
  → SLEEP_RETRY (push-race backoff)
  → PARKED (long-running PR — Q6)
  → NEEDS_HUMAN_ATTENTION → DONE_WITH_FLAG (any cap exceeded)
```

Per-worker state is persisted to
`$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` for
forensics + the future `cli-status --orchestrator` view (Phase 4). Per
RFC §13 Q2 the file is **not consulted for resume** — orchestrator
restart re-derives state from the frontier + git + gh.

### Per-project override example

A project that prefers human triage on secret-scan blocks (rather than
the auto-rewrite approach) sets:

```yaml
# .ai-sdlc/orchestrator-failure-patterns.yaml
version: v1
patterns:
  - mode: SecretScanBlocked
    budget: 0
    escalateImmediately: true
    description: 'Secret-scan blocks always need human review per project policy.'
  # Other 8 modes inherit defaults — listing only the override is fine.
```

Both `budget: 0` and `escalateImmediately: true` skip the remediation
loop and route straight to escalation. The loader merges per-mode
overrides on top of the bundled `DEFAULT_CATALOGUE` so a partial file
like the one above is valid (the missing 8 modes get their RFC §5.1
defaults).

### Audit checklist (RFC §13 Q4 — parallel remediation, no global locks)

Each handler module under
[`pipeline-cli/src/orchestrator/playbook/handlers/`](../src/orchestrator/playbook/handlers)
is audited against:

1. **No writes to `OrchestratorConfig` in-memory state.** Mutating
   `failureBudgets[mode]++` would race across workers — disallowed.
2. **No writes outside the worker's own worktree branch** (other than
   the merge-gate-mediated `git push`).
3. **No invalidation of shared caches** (the orchestrator has no
   caches per RFC-0014 Q4; this remains true here).
4. **`gh` calls scoped to the worker's PR number** (`gh pr edit
   <pr-num>`, never the implicit current-branch resolution that could
   race when two workers share a sandbox).

The audit is a code-review checklist; v1 default is **parallel-no-lock**
per Q4. Per-mode locks (Option C) are added only if a real global-state
collision surfaces.

> Phase 4 (AISDLC-169.4) replaces the in-memory `playbookEvents` array
> with the canonical `events.jsonl` bus — see the next section.

## Observability — Phase 4 events.jsonl + cli-status (AISDLC-169.4)

Phase 4 ships the canonical event stream and the operator-facing
viewer.

### Event stream — `events.jsonl`

Every tick, the orchestrator emits one or more events to a date-rotated
JSONL file at `$ARTIFACTS_DIR/_orchestrator/events-YYYY-MM-DD.jsonl`.
The writer:

- is **append-only** — never rewrites or reorders existing lines (RFC §7.3 contract);
- **rotates by UTC date** — operators in any timezone get deterministic file naming;
- **creates parent dirs** on demand;
- is **feature-flag gated** — when `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` is unset the writer no-ops, so accidental imports never leak observability traffic;
- is **best-effort** — write failures (disk full, EBADF) are swallowed; the orchestrator hot loop is never crashed by an observability hiccup.

### Event types (Phase 4 surface)

| Type | When | Required fields | Notes |
|---|---|---|---|
| `OrchestratorTick` | Top of every tick, after the frontier read | `ts`, `type`, `tick`, `runId`, `candidates`, `dispatched` | Heartbeat — the loop is alive even with an empty frontier. |
| `OrchestratorDispatched` | Before each `executePipeline()` call | `ts`, `type`, `taskId`, `tick`, `runId` | Forensic anchor — proves a task started even if dispatch hard-crashes. |
| `OrchestratorCompleted` | After a successful dispatch return | `ts`, `type`, `taskId`, `tick`, `runId`, `outcome`, `prUrl` | `outcome` is the `PipelineOutcome` enum value. |
| `OrchestratorFailed` | Caught error OR escalated playbook OR `needs-human-attention` outcome | `ts`, `type`, `taskId`, `tick`, `runId`, `mode`, `reason`, `prUrl` | `mode` is the `FailureMode` (catalogued) or `UnknownFailureMode` (catch-all). |
| `OrchestratorRecovered` | Phase 2 playbook handler succeeded | `ts`, `type`, `taskId`, `tick`, `runId`, `mode`, `outcome`, `prUrl` | Wires to AISDLC-169.2 — emitted on the recovered branch of the playbook runner. |
| `OrchestratorAwaitingExternal` | Phase 3 admission filter held the task | `ts`, `type`, `taskId`, `runId`, `reason`, `context` | Reserved for AISDLC-169.3; schema accepts it now so the loop wiring is non-breaking when Phase 3 lands. |
| `WorkerStateTransition` | Every Phase 2 state-machine transition | `ts`, `type`, `taskId`, `workerId`, `runId`, `from`, `to`, `duration_ms`, `context?` | Forwarded from the in-memory `playbookEvents` array Phase 2 already emits. Mirrors RFC §7.1. |

The schema is canonical at
[`spec/schemas/orchestrator-events.v1.schema.json`](../../spec/schemas/orchestrator-events.v1.schema.json).
Future RFC-0015 phases (or other RFCs) extend the `OrchestratorEventType`
enum without a v2 bump — consumers that enforce the enum strictly will
reject unknown types + log; consumers that don't will tolerate them.

### Common envelope

Every event carries:

- **`ts`** — ISO-8601 timestamp set by the writer at append time.
- **`type`** — discriminator (the `OrchestratorEventType` enum).
- **`runId`** (optional) — orchestrator session UUID. Stable across all ticks within one `runOrchestratorLoop()` invocation; lets consumers correlate events from one process even when the date-rotated file rolls over mid-run.
- **`tick`** (optional) — tick number this event was emitted in (0-indexed).
- **`taskId`** (optional) — present on task-scoped events; absent on `OrchestratorTick`.
- **`workerId`** (optional) — present on `WorkerStateTransition`.

### Consumer guide — tail + filter

The recommended consumer pattern is **tail + filter** — a downstream
process tails the latest `events-YYYY-MM-DD.jsonl` file (rolling over at
UTC midnight) and applies its own filtering. Examples:

- **Slack push** (RFC §13 Q1 layer C): tail, filter for `type === 'OrchestratorFailed'` AND `mode === 'UnknownFailureMode'`, post to a webhook with the task ID + reason.
- **Web dashboard** (RFC §7.3 — future task): tail via `inotify` / `fs.watch` → SSE, render the four §7.2 panels (workers table, candidate queue, recent transitions, burn-down).
- **Replay / chaos-test fixtures** (RFC §11 Phase 5 — AISDLC-169.5): record a session's `events-YYYY-MM-DD.jsonl` as a corpus, replay against a mock orchestrator to assert recovery semantics.

The schema's `additionalProperties: false` on the top-level envelope
combined with the `[k: string]: unknown` per-type properties keeps the
contract honest: consumers can validate the envelope strictly + tolerate
new per-type fields.

### `cli-status --orchestrator`

Operator-facing landing page for the events stream. Lives in
`@ai-sdlc/dogfood` (already-shipped binary), gains a new `--orchestrator`
flag in Phase 4:

```bash
node dogfood/dist/cli-status.js --orchestrator
node dogfood/dist/cli-status.js --orchestrator --json --limit 20
node dogfood/dist/cli-status.js --orchestrator --artifacts-dir .ai-sdlc/artifacts
```

Renders the last 50 events (configurable via `--limit`) in chronological
order, color-coded by type:

- **green** — `OrchestratorCompleted`, `OrchestratorRecovered` (terminal success)
- **red** — `OrchestratorFailed` (escalation surface)
- **yellow** — `OrchestratorAwaitingExternal` (Phase 3 admission filter)
- **cyan** — `OrchestratorDispatched` (worker started)
- **magenta** — `WorkerStateTransition` (in-flight forensic trail)
- **gray** — `OrchestratorTick` (loop heartbeat — low-information by design)

Each line is `<ts> <type> taskId=<id> runId=<short-uuid>`. Color
auto-disables on non-TTY stdout (CI-safe). `--json` emits the raw event
array for piping into `jq` / dashboards.

### Dashboard mock

Phase 4 ships the schema, NOT the dashboard view. The schema is the
locked-in contract; a future task wires a web dashboard (or the
`inotify` → SSE replication suggested in RFC §7.3) against it. Until
then `cli-status --orchestrator` is the operator's UI; consumers
prototype against the schema directly.

### Programmatic consumer API

```ts
import { readRecentEvents, type OrchestratorEvent } from '@ai-sdlc/pipeline-cli/orchestrator';

const events: OrchestratorEvent[] = readRecentEvents({
  artifactsDir: '/srv/ai-sdlc/.ai-sdlc/artifacts',
  limit: 50,
});

for (const e of events) {
  if (e.type === 'OrchestratorFailed') {
    // ... post to Slack, file an issue, etc.
  }
}
```

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

## Promotion to default-on (RFC-0015 Phase 5)

Phase 5 ships the soak corpus aggregator + chaos-test harness + the
hybrid promotion runbook. Same pattern as
RFC-0014 (`AI_SDLC_DEPS_COMPOSITION`) and RFC-0011 (DoR `enforce`
mode): build measurement infrastructure + write a runbook with two
paths (corpus path for math-rigorous evidence, operator-override path
for spot-check evidence), then operator dispatches the flag flip from
the runbook once either path's evidence supports it.

### Corpus aggregator — `cli-orchestrator-corpus`

Aggregates downloaded `events.jsonl` artifacts into an
unattended-completion + quota-burn report and a recommendation
envelope (`safe-to-promote | continue-soak | insufficient-data`).

```bash
# Collect events from local + CI runs.
mkdir -p ./orchestrator-corpus
cp -r ./artifacts/_orchestrator/* ./orchestrator-corpus/
gh run list --limit 100 --json databaseId \
  | jq -r '.[].databaseId' \
  | while read run_id; do
      gh run download "$run_id" --pattern '*-orchestrator-events' --dir ./orchestrator-corpus 2>/dev/null || true
    done

# Ask: are we safe to promote?
node pipeline-cli/bin/cli-orchestrator-corpus.mjs aggregate ./orchestrator-corpus --format table
```

The `--format table` output is operator-eyeball friendly; default
JSON output is for CI pipelines / `jq`-driven dispatch decisions. See
[`docs/operations/orchestrator-promotion.md`](../../docs/operations/orchestrator-promotion.md)
for the full runbook including the override path, the flag-flip PR
template, and the rollback procedure.

### Soak measurement methodology

The aggregator buckets events by `runId` (the orchestrator session
UUID stamped on every event) so multi-day runs that span date-rotated
files are counted once rather than once-per-rotation. Per-run metrics:

| Metric | Definition | Promotion gate |
|---|---|---|
| `dispatched` | Count of `OrchestratorDispatched` events | ≥20 across the corpus (RFC §11 Phase 5) |
| `distinctTaskIds` | Distinct task IDs dispatched | ≥3 across the corpus (RFC §11 "≥3 RFCs" operationalised) |
| `unattendedRate` | `(completed + recovered) / dispatched` | ≥0.95 (RFC §11 "95%+ tasks complete without human intervention") |
| `quotaBurnRatio` | `tokensConsumed / tokensProjected` (per run) | ≤1.10 — runs above this count as a "surprise" |
| `quotaBurnSurprises` | Count of runs with `quotaBurnRatio > threshold` | Must be `0` for `safe-to-promote` |
| `failureModes` | Per-mode tally from `OrchestratorFailed` events | Forensic — guides catalogue extension |

The `tokensConsumed` is summed from `context.tokens` on completion +
failure events (Phase 4 `additionalProperties: true` on
`OrchestratorEvent.context` makes this opt-in extensible). Older runs
that lack token data are excluded from the burn-rate denominator —
they don't poison the signal but also don't contribute to it.

### Chaos test — `chaos.test.ts`

Hermetic harness covering the three RFC §11 Phase 5 scenarios from
the AISDLC-169.5 brief:

1. **Mid-dispatch kill** — dispatch throws; loop catches, escalates
   `UnknownFailureMode`, events.jsonl integrity preserved, next tick
   re-dispatches cleanly.
2. **Mid-finalize kill** — events sink throws on completion; loop
   absorbs the throw (writer is best-effort), tick result still
   propagates the dispatch outcome.
3. **Mid-remediation kill** — worker state file persisted atomically
   after every transition; the most recent transition is always
   visible to a post-mortem reader (`readPersistedWorkerState`).

Plus events.jsonl append-only integrity (subsequent tick failures do
not corrupt prior events) and the SIGTERM drain → fresh-orchestrator
contract (one orchestrator's events file appended-to by the next
orchestrator's runId, never truncated).

Runs as part of `pnpm --filter @ai-sdlc/pipeline-cli test`. A
failure here MUST block promotion — the recovery contract (RFC §13
Q2 idempotent finalize) is what makes the autonomous mode safe.

### Promotion-decision template

This is the format AISDLC-169.5's PR description follows; future
RFC-driven flag promotions can copy it verbatim.

```markdown
## Promotion: AI_SDLC_AUTONOMOUS_ORCHESTRATOR default OFF → ON

### Evidence

**Path:** corpus | override (pick one)

**Corpus:** [paste `cli-orchestrator-corpus aggregate ./corpus --format table` output]

**Spot-check:** [paste `cli-status --orchestrator --limit 50` highlights, OR explain why corpus path was sufficient]

**Chaos test:** `pnpm --filter @ai-sdlc/pipeline-cli test src/orchestrator/chaos.test.ts` — clean (paste excerpt)

### Change

[Option A diff — flip parser default in `feature-flag.ts`, OR Option B — add env to workflow/unit]

### Rollback

[Single-line revert command]
```

## Phase plan

| Phase | Task | Scope | Status |
|---|---|---|---|
| 1 | AISDLC-169.1 | Bare polling loop, feature flag, escalation hook, `cli-orchestrator` CLI, idempotent-finalize doc. | Shipped |
| 2 | AISDLC-169.2 | 9-pattern failure playbook + `.ai-sdlc/orchestrator-failure-patterns.yaml` source-of-truth + worker state machine + per-worker forensic state. | Shipped |
| 3 | AISDLC-169.3 | DoR + dependency + external-deps pre-dispatch admission filters; exponential-backoff cadence. | In flight |
| 4 | AISDLC-169.4 | `events.jsonl` writer + `cli-status --orchestrator` view + canonical schema for downstream consumers. | Shipped |
| 5 (this) | AISDLC-169.5 | Soak corpus aggregator (`cli-orchestrator-corpus`), chaos test harness, hybrid promotion runbook. | Shipped |

## Cross-references

- [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md) — full RFC including §13 open-question resolutions.
- [`pipeline-cli/docs/spawner.md`](./spawner.md) — picking the right `SubagentSpawner` for your environment.
- [`pipeline-cli/docs/dependency-graph.md`](./dependency-graph.md) — the cli-deps frontier query the orchestrator drives.
- [`docs/operations/deps-composition.md`](../../docs/operations/deps-composition.md) — RFC-0014 composition layer + `AI_SDLC_DEPS_COMPOSITION`.
- [`docs/operations/orchestrator-promotion.md`](../../docs/operations/orchestrator-promotion.md) — Phase 5 hybrid promotion runbook (corpus path + override path + flag flip + rollback).
- [`docs/operations/operator-runbook.md`](../../docs/operations/operator-runbook.md) — orchestrator-specific failure-mode triage (UnknownFailureMode, parked-worker, OrchestratorStuckCandidate, chaos-test rerun).
