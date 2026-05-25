# Orchestrator operator runbook

**Audience**: AI-SDLC operators running `cli-orchestrator tick` /
`cli-orchestrator start` against a real backlog, plus anyone diagnosing
events.jsonl after a failed run.

This runbook is the day-to-day companion to the promotion runbook at
[`orchestrator-promotion.md`](./orchestrator-promotion.md) and the spec
at [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).

---

## Auto-rebuild of stale `pipeline-cli/dist/` (AISDLC-226)

`pipeline-cli/dist/` is gitignored. After `git pull`, the compiled output
stays at your last manual `pnpm build`. Running `cli-orchestrator tick` or
`cli-orchestrator start` with a stale `dist/` silently runs OLD code —
filters and features that shipped in `src/` are not active.

### How it works

At the start of every `tick` and `start` invocation the orchestrator compares
the mtime of two sentinel files:

- **`src/index.ts`** — newest-touched source file proxy
- **`dist/index.js`** — compiled output proxy

If `src/index.ts` is newer than `dist/index.js`, the orchestrator:

1. Logs a single line to stderr:
   ```
   [orchestrator] dist/ stale, rebuilding pipeline-cli
   ```
2. Runs `pnpm --filter @ai-sdlc/pipeline-cli build` with inherited stdio so
   you see the TypeScript compiler output in real time.
3. Proceeds normally once the build succeeds.

If the build exits non-zero the orchestrator **aborts** with a clear error
message — it does NOT silently proceed with stale dist.

### Skip the auto-rebuild

Set `AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1` to disable the staleness check.
Use this in:

- **CI environments** — dist is built by the CI step that precedes the orchestrator.
- **Packaged / containerised deployments** — dist is baked into the image.
- **Development loops** where you know dist is fresh and want to skip the stat.

```bash
export AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1
node pipeline-cli/bin/cli-orchestrator.mjs tick
```

### Manually rebuild if needed

```bash
pnpm --filter @ai-sdlc/pipeline-cli build
```

Or from the workspace root:

```bash
pnpm build
```

After a successful build, run `cli-orchestrator tick` normally — the staleness
check will see that `dist/index.js` is now newer and skip the rebuild.

---

## Full-pipeline umbrella dispatch (AISDLC-229)

As of AISDLC-229, `cli-orchestrator tick` dispatches tasks through the
`ai-sdlc-pipeline execute` umbrella (AISDLC-182) rather than shelling out
to `claude --print --agent developer` directly. This means each admitted
task now runs the full Step 0-13 pipeline:

- Step 7: spawn three reviewer subagents (code / test / security)
- Step 8: aggregate verdicts → write `.ai-sdlc/verdicts/<task-id-lower>.json`
- Step 10: sign DSSE attestation envelope
- Step 11: push branch + open PR
- Step 12: open sibling-repo PRs (when `permittedExternalPaths` declared)
- Step 13: cleanup `.active-task` sentinel

### Spawner choice: `--spawner` / `AI_SDLC_ORCHESTRATOR_SPAWNER`

`cli-orchestrator tick` and `cli-orchestrator start` can explicitly select
the umbrella spawner:

```bash
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
export CODEX_SPAWN_AGENT_BIN="$(pwd)/scripts/codex-spawn-agent-bridge.mjs"
node pipeline-cli/bin/cli-orchestrator.mjs tick --spawner codex --max-concurrent 1
```

The same selection can be made with an environment variable, which is useful
for systemd, cron, and long-running `start` processes:

```bash
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
export AI_SDLC_ORCHESTRATOR_SPAWNER=codex
export CODEX_SPAWN_AGENT_BIN="$(pwd)/scripts/codex-spawn-agent-bridge.mjs"
node pipeline-cli/bin/cli-orchestrator.mjs start --max-concurrent 1
```

Supported values are `mock`, `api-key`, `claude`, and `codex`. Selecting
a spawner explicitly opts the orchestrator into umbrella dispatch for admitted
tasks. When no spawner is selected and `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA` is
unset, the existing default behavior is unchanged.

The legacy `claude-cli` inline-manifest spawner was removed in RFC-0041
Phase 3.3 (AISDLC-377.6). See
[`docs/operations/claude-cli-spawner-removed.md`](./claude-cli-spawner-removed.md)
for the migration breadcrumb.

For `codex`, the underlying `ai-sdlc-pipeline execute --spawner codex` path
constructs `CodexHarnessAdapter` from `CODEX_SPAWN_AGENT_BIN`. If the bridge
is unset, the command fails during spawner resolution before task validation,
worktree setup, or status mutation.

### Fallback: `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK`

The default spawner for the umbrella is `claude` (shells out to `claude -p`
for subscription billing, AISDLC-352).

The `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` env var was originally
a retry hook for the `claude-cli` "manifest not consumed" failure mode.
RFC-0041 Phase 3.3 (AISDLC-377.6) removed the `claude-cli` spawner, so the
retry guard never fires now (the env var is left in place as a configuration
hook for future spawners with analogous transient-unavailability modes).
Setting it still triggers the `FALLBACK_BILLING_WARNING` from
`emitBillingSafetyWarnings` so operators see the same diagnostic at tick
start, but no automatic api-key retry will fire.

If the configured spawner is unavailable, the dispatch records a failure in
`outcomes[i].failure` with `type: 'spawner-unavailable'` and continues to
the next admitted task — it never blocks the entire tick.

### `pipeline.*` outcome fields (AISDLC-229)

Each `outcomes[i]` entry in the tick result now carries optional `pipeline`
and `failure` fields populated from the umbrella's return envelope:

```json
{
  "taskId": "AISDLC-99",
  "outcome": "approved",
  "prUrl": "https://github.com/org/repo/pull/42",
  "pipeline": {
    "attestationSha": null,
    "prNumber": 42,
    "reviewerVerdicts": {
      "code": "approved",
      "test": "approved",
      "security": "approved"
    },
    "iterations": 2
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `pipeline.attestationSha` | `string \| null` | HEAD SHA after the DSSE attestation chore commit. `null` when reviewers didn't run. |
| `pipeline.prNumber` | `number \| null` | GitHub PR number parsed from `prUrl`. `null` on failure paths. |
| `pipeline.reviewerVerdicts` | `{ code, test, security } \| null` | Per-reviewer `"approved"` or `"changes-requested"`. `null` when reviewers didn't run. |
| `pipeline.iterations` | `number \| null` | Number of review iterations the umbrella ran. `null` on pre-review failures. |

The `pipeline` field is `undefined` when:
- The legacy `dispatch` adapter was injected (backwards-compatible test paths).
- The umbrella failed before the review phase.

The `failure` field (when present):

```json
{
  "failure": {
    "type": "developer-failed",
    "message": "developer returned commitSha: null"
  }
}
```

| `failure.type` | Cause |
|---|---|
| `developer-failed` | Dev subagent returned `commitSha: null` (no work produced). |
| `developer-json-contract-violated` | Dev returned prose twice; umbrella gave up. |
| `aborted` | Push or `gh pr create` failed mid-flight. |
| `spawner-unavailable` | Configured spawner could not be resolved (missing env var, binary not on PATH, etc.); no fallback configured. |
| `unknown` | Catch-all for other umbrella failures. |

### What to do if the umbrella fails mid-tick

**If `failure.type === 'developer-failed'` or `aborted`:**
The orchestrator's AISDLC-177 rollback fires automatically: it reverts the
task status to its pre-dispatch value, removes the worktree, and
(if the dev produced commits) quarantines the branch under
`quarantine/<task-id-lower>-<ts>`. The next tick will re-pick the task.
See the "Recovering quarantined work" section below for forensic inspection.

**If `failure.type === 'spawner-unavailable'`:**
The configured spawner could not be resolved. Common causes: `claude` binary
not on PATH for `--spawner claude`, `ANTHROPIC_API_KEY` unset for
`--spawner api-key`, `CODEX_SPAWN_AGENT_BIN` unset for `--spawner codex`.
Fix the env / install gap and re-dispatch the task.

**If `failure.type === 'unknown'`:**
Inspect the `message` field. Common causes:
- `ANTHROPIC_API_KEY` missing when `--spawner api-key` was requested.
- Validation failure in Step 1 (malformed task frontmatter).
- Network errors during `gh pr create`.

To re-dispatch manually, reset the task status to `To Do` (the rollback
does this automatically, but you can also do it via the plugin MCP tool):

```bash
mcp__plugin_ai-sdlc_ai-sdlc__task_edit AISDLC-99 --status "To Do"
```

---

## Subscription-billed autonomous drain (Dispatch Board model)

RFC-0041 Phase 3.3 (AISDLC-377.6) removed the legacy `--spawner claude-cli`
inline-manifest path; the recommended way to run subscription-billed autonomous
drain is now the **Dispatch Board** (RFC-0041 Conductor/Worker architecture):

- **Conductor** — one operator-opened CC session running
  `/ai-sdlc orchestrator-tick`. Loops via `ScheduleWakeup(30s)`, scans the
  backlog frontier, writes per-task manifests to `.ai-sdlc/dispatch/queue/`,
  reconciles completion verdicts from `done/`, fans out reviewers, signs
  attestations, and flips draft PRs to ready-for-review.
- **Workers** — N additional operator-opened CC sessions, each running
  `/ai-sdlc dispatch-worker`. Each Worker claims a manifest from the queue,
  fires a foreground `Agent(developer)`, and writes the result back to the
  board. N sessions = N-wide parallelism at **zero incremental cost** beyond
  the operator's existing Claude Code Max subscription.

For headless / CI contexts (no operator CC session), use
[`docs/operations/dispatch-supervisor-install.md`](./dispatch-supervisor-install.md)
to run the `cli-dispatch-supervisor` daemon — it spawns `env -u CLAUDECODE
claude -p` subprocess Workers with operator-controlled 30 min watchdogs.

### Prerequisites

1. Claude Code Max subscription (any tier).
2. `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` (or unset / truthy — default-ON
   since AISDLC-411).
3. Backlog with at least one task in `To Do` status.
4. Working directory is the project root (where `backlog/`, `.worktrees/`,
   and `.ai-sdlc/dispatch/` live).

### Plain-shell autonomous tick (cron / daemon / sidecar)

If no operator CC session is available, the simplest path is:

```bash
cli-orchestrator tick                # default: --spawner claude
# OR explicitly:
cli-orchestrator tick --spawner claude
```

`--spawner claude` shells out to `claude -p` for each dispatch. Uses
subscription auth (Agent SDK credit pool post-2026-06-15).

### Migrating from the legacy inline-manifest path

If you currently run `cli-orchestrator tick --spawner claude-cli` (or any
script that does), see
[`docs/operations/claude-cli-spawner-removed.md`](./claude-cli-spawner-removed.md)
for the full migration breadcrumb.

---

## In-flight detection — preventing duplicate dispatches (AISDLC-227)

The orchestrator's `AlreadyInFlight` admission filter prevents `cli-orchestrator tick`
from re-dispatching a task that is already being processed by a concurrent pipeline run.
Without this filter, a slow-merging PR or a still-running dev subprocess in another session
causes a duplicate dispatch on every tick — the witness was AISDLC-202.2 (PR #402 already
open, worktree already existed, `git worktree add` failed with "branch already exists" and
wasted ~30s of tick + setup overhead per attempt).

### How the filter works

The filter runs BEFORE `DependencyReadiness` and checks three signals in order,
short-circuiting on the first hit:

| Signal | Check | Always active? |
|---|---|---|
| (a) **Open PR** | `gh pr list --head ai-sdlc/<task-id-lower>-* --state open` returns ≥1 entry | Yes |
| (b) **Active worktree sentinel** | `.worktrees/<task-id-lower>/.active-task` exists on disk | Yes |
| (c) **Live subprocess** | A `claude --print` or `claude -p` process with the task ID in its argv | Behind `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS` (default ON) |

Signal (a) is the definitive signal — a PR exists means a full pipeline run completed or is
in review. Signal (b) detects an active session mid-flight. Signal (c) is a best-effort
process-table scan using portable `ps -ax -o pid,command` (Darwin + Linux); it silently
no-ops on errors.

### Trace output

When the filter fires, the tick trace includes a rejection line:

```
[orchestrator] filter trace for AISDLC-202.2:
  - Orphan-parent check: passed
  - Already-in-flight check: failed (PR #402 open)
  → skipped, already in flight (PR #402 already open)
```

Other rejection patterns:

```
  - Already-in-flight check: failed (active worktree)
  → skipped, already in flight (active worktree sentinel at /repo/.worktrees/aisdlc-202.2/.active-task)
```

```
  - Already-in-flight check: failed (live subprocess PID 12345)
  → skipped, already in flight (live claude --print subprocess for AISDLC-202.2 (PID 12345))
```

### Enabling / disabling subprocess detection

Subprocess detection (signal c) is **enabled by default** for tick and start modes.
Disable it by setting:

```bash
export AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS=0
```

Canonical truthy values that keep it enabled: `1`, `true`, `yes`, `on` (case-insensitive).
Tests should pass `detectSubprocess: false` in `alreadyInFlightOpts` to stay hermetic.

### When the filter fires but shouldn't (false positives)

**Open-PR signal (a)**: Fires correctly when the PR is still in review or in the merge queue.
If you need to re-dispatch the task anyway (e.g. the PR was abandoned), close the PR first or
rename the branch so it no longer matches the `ai-sdlc/<task-id-lower>-*` pattern, then run
the next tick.

**Worktree sentinel (b)**: The `.active-task` sentinel is removed by Step 13 (cleanup) after
a successful pipeline run. If it persists due to a crashed session, remove it manually:

```bash
rm .worktrees/<task-id-lower>/.active-task
# or remove the whole worktree if no in-progress work is present:
git worktree remove --force .worktrees/<task-id-lower>
```

**Subprocess signal (c)**: If the subprocess detection is mis-firing (rare — requires a
`claude --print` process whose argv happens to contain the task ID), disable it via the env
var above and investigate.

---

## Blast-radius overlap — preventing parallel dispatch of conflicting tasks (AISDLC-231)

The orchestrator's `BlastRadiusOverlap` admission filter prevents two tasks whose
file-level blast-radius overlaps from running in parallel. Without this filter, two
concurrent subagents can race to edit the same files, producing conflicting diffs that
either fail to rebase cleanly or produce silent merge-order bugs that slip past CI.

### How the filter works

The filter runs AFTER `AlreadyInFlight` and BEFORE `DependencyReadiness`. For each
candidate task it:

1. Computes the candidate's blast-radius file set from the task's `references:` frontmatter
   (v1). If the field is absent or empty the candidate is **admitted unconditionally** (degrade-open
   policy — the filter cannot block what it cannot measure).
2. Collects all in-flight task IDs from two sources:
   - Open PRs with a branch matching `ai-sdlc/*` (via `gh pr list`).
   - `.worktrees/<dir>/.active-task` sentinel files on disk.
3. For each in-flight task, computes its blast-radius file set and intersects it with the
   candidate's set. Intersection is exact-path OR directory-prefix (a candidate file of
   `src/foo/bar.ts` overlaps an in-flight entry of `src/foo/` and vice-versa).
4. If any in-flight task's set intersects the candidate's set, the filter **blocks** the
   candidate for this tick, emitting an `OrchestratorBlockedByBlastRadiusOverlap` event.
   The first overlapping task is cited in the event payload.

### Trace output

When the filter blocks a candidate:

```
[orchestrator] filter trace for AISDLC-300:
  - Orphan-parent check: passed
  - Already-in-flight check: passed
  - Blast-radius overlap check: failed (overlaps AISDLC-299 on 2 file(s): pipeline-cli/src/orchestrator/filters/chain.ts, ...)
  → skipped, blast-radius overlap with in-flight task AISDLC-299 (2 file(s) in common)
```

When the candidate has no computable blast-radius (degrade-open):

```
  - Blast-radius overlap check: passed (degrade-open — empty blast-radius)
```

### events.jsonl payload

Each blocked candidate emits one `OrchestratorBlockedByBlastRadiusOverlap` event per tick:

```json
{
  "type": "OrchestratorBlockedByBlastRadiusOverlap",
  "ts": "2026-05-09T12:34:56.789Z",
  "taskId": "AISDLC-300",
  "inFlightTaskId": "AISDLC-299",
  "overlap": ["pipeline-cli/src/orchestrator/filters/chain.ts"],
  "overlapCount": 1
}
```

### Bypass overrides

Two environment variables override the filter in exceptional circumstances:

| Variable | Effect |
|---|---|
| `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=1` | Global bypass — all candidates are admitted regardless of overlap |
| `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK=AISDLC-300` | Per-task bypass — only the named task is admitted; others are still filtered |

Both are opt-in and not set by default. Tests should **not** set these; use the
`computeBlastRadiusFiles` / `listOpenPRs` injection points in `blastRadiusOverlapOpts`
instead to stay hermetic.

### When the filter fires but shouldn't (false positives)

The `references:` field is currently the only source of blast-radius truth (v1). If two
tasks legitimately share a reference file but edit different functions within it, the filter
is overly conservative. Options:

1. **Wait** — once the in-flight task's PR merges, the overlap disappears and the held task
   is admitted on the next tick automatically.
2. **Per-task bypass** — `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK=<candidate-id>` if the
   operator is confident the actual edits won't conflict.
3. **Update `references:`** — remove the shared file from the candidate's frontmatter if it
   is not genuinely a target of that task's edits (requires updating the task file and
   re-pushing to backlog main).

---

## Blocking a task from orchestrator dispatch (AISDLC-223)

The orchestrator's `Blocked` admission filter lets operators put a task on
hold without changing its status, removing it from the backlog, or modifying
the dependency graph. A blocked task is skipped on every tick until the
operator removes the `blocked.reason` field.

### When to use

- A task is "ready by all criteria" but you need to wait for an external
  signal before dispatching it — e.g. a soak window, a human decision, a
  dependency outside the task graph.
- AISDLC-115 is the canonical first user: RFC-0011 DoR Gate, soaking for
  promotion evidence. Mark it blocked until the soak window closes so the
  orchestrator stops re-picking it every tick.

### Frontmatter shape

Add a `blocked:` field to the task's YAML frontmatter:

```yaml
---
id: AISDLC-115
status: In Progress
blocked:
  reason: "Soaking — feature flag promotion gated on AISDLC-116 evidence"  # required
  until: "2026-05-13"           # optional advisory ISO date
  unblockedBy: ["AISDLC-116"]   # optional task IDs whose completion unblocks this
---
```

- `reason` (string, required) — any non-empty string activates the block.
  The orchestrator will emit this string verbatim in `TaskBlocked` events.
- `until` (string, optional) — an advisory ISO date. The orchestrator does
  NOT auto-unblock on this date (Phase 2 / AC #8); it is informational only
  and surfaces in `TaskBlocked` events + `cli-orchestrator status` output.
- `unblockedBy` (array, optional) — advisory task IDs to monitor. Same
  advisory semantics as `until` — no auto-unblock in v1.

### Editing the blocked field

Use `mcp__backlog__task_edit` or hand-edit the task file:

```bash
# Set the blocked field
mcp__backlog__task_edit AISDLC-115 blocked.reason "Soaking — gated on AISDLC-116"

# Or hand-edit the YAML frontmatter in backlog/tasks/aisdlc-115 - *.md
```

### Unblocking a task

Remove the `blocked` field (or set `blocked.reason` to an empty string):

```bash
# Remove the field entirely via task_edit
mcp__backlog__task_edit AISDLC-115 blocked null

# Or hand-edit: delete the blocked: block from the YAML frontmatter
```

The next orchestrator tick will admit the task normally (all other filters
still apply).

### Observability: TaskBlocked events

Every tick that the `Blocked` filter rejects a task emits a `TaskBlocked`
event to `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl`:

```json
{
  "type": "TaskBlocked",
  "ts": "2026-05-06T12:34:56Z",
  "taskId": "AISDLC-115",
  "reason": "Soaking — feature flag promotion gated on AISDLC-116 evidence",
  "until": "2026-05-13"
}
```

Grep for blocked tasks across all event files:

```bash
grep '"TaskBlocked"' artifacts/_orchestrator/events-*.jsonl | jq .
```

### Observability: cli-orchestrator status

`cli-orchestrator status` includes a `blocked` array in its JSON output:

```json
{
  "ok": true,
  "mode": "status",
  "status": {
    "blocked": [
      {
        "taskId": "AISDLC-115",
        "reason": "Soaking — feature flag promotion gated on AISDLC-116 evidence",
        "until": "2026-05-13"
      }
    ]
  }
}
```

An empty `"blocked": []` means no frontier tasks are currently blocked.

---

## Recovering quarantined work after a failed dispatch (AISDLC-177)

When the orchestrator dispatches a task and the dispatcher (Step 6
parse, the dev subagent itself, or any later step) reports a
non-recoverable failure — `developer-failed`,
`developer-json-contract-violated`, `aborted`, or an uncatalogued
exception — the orchestrator now **rolls back** Step 4's side-effects
automatically:

1. Reverts the task file's `status:` line back to whatever it was
   BEFORE the orchestrator picked the task (typically `To Do`).
2. Removes the worktree at `.worktrees/<task-id-lower>/` via
   `git worktree remove --force`. The per-worktree `.active-task`
   sentinel goes with it.
3. **Preserves any commits the dev produced** by renaming the dev's
   branch under `quarantine/<task-id-lower>-<iso-timestamp>` instead
   of deleting it. This is the recovery path operators care about.
4. Emits an `OrchestratorRollback` event on the events.jsonl bus +
   (when commits were preserved) an `OrchestratorWorkQuarantined`
   companion event with the SHA + commit count.

### Step 1: identify a quarantined ref

Either:

- **From events.jsonl** — grep for the quarantine event:
  ```bash
  grep '"OrchestratorWorkQuarantined"' artifacts/_orchestrator/events-*.jsonl
  ```
  Each line carries `taskId`, `branch` (the original
  `ai-sdlc/<id-lower>` ref name), `quarantineRef`, `commitSha`, and
  `commitCount`.

- **From git** — list every quarantine ref directly:
  ```bash
  git branch --list 'quarantine/*'
  ```
  Refs are named `quarantine/<task-id-lower>-<YYYY-MM-DDTHH-MM-SS-mmm>`
  (UTC, millisecond precision per AISDLC-186). The timestamp suffix is
  the rollback wall-clock, not the commit's authored time. Pre-186 refs
  used second precision (`...T14-23-44`) and may still be present in
  long-lived repos — both formats sort lexicographically by date so
  `git branch --list` returns them interleaved as expected.

### Step 2: inspect the preserved work

```bash
git log quarantine/aisdlc-70-2026-05-04T14-23-44 --not origin/main --oneline
```

If the commits look salvageable, check out a fresh feature branch from
the quarantine ref:

```bash
git checkout -b ai-sdlc/aisdlc-70-recovered quarantine/aisdlc-70-2026-05-04T14-23-44
```

Carry the change forward yourself:

- Cherry-pick into a fresh worktree if the dev's work was almost
  complete but hit a non-deterministic failure.
- Open a PR manually if the commits already pass review locally.
- Discard the ref if the work was wrong-headed (the orchestrator did
  the right thing flagging it):
  ```bash
  git branch -D quarantine/aisdlc-70-2026-05-04T14-23-44
  ```

### Step 3: re-dispatch the task (optional)

The original task's status was reverted to `To Do` by the rollback,
so the next orchestrator tick will pick it up again automatically.
If you want to skip re-dispatch (because you're carrying the work
forward yourself), set the status to `In Progress` manually so the
admission filters skip it:

```bash
# via the plugin MCP tool inside Claude Code
mcp__plugin_ai-sdlc_ai-sdlc__task_edit AISDLC-70 --status "In Progress"
```

### What the rollback does NOT touch

- **`approved` outcomes** — the dev's PR is already opened, no
  rollback fires. The worktree is swept by the normal Step 13 cleanup.
- **`needs-human-attention` outcomes** — the orchestrator deliberately
  leaves the worktree intact so the operator can iterate from where
  the dev stopped. The PR carries a `needs-human-attention` label
  (RFC-0015 §13 Q1).
- **`task-already-in-flight` rejections** — no dispatch happened,
  nothing to roll back. The pre-dispatch filter catches these
  silently with an `OrchestratorTaskAlreadyInFlight` event.
- **Filter-chain rejections** (`OrchestratorBlockedByDependency`,
  `OrchestratorBlockedByDor`, `OrchestratorAwaitingExternal`,
  `OrchestratorOrphanParent`, `OrchestratorBlockedByBlastRadiusOverlap`) —
  the orchestrator never invoked Step 4, so there's nothing to roll back.

### Failure modes inside rollback itself

The rollback helper is best-effort: every step (status revert, branch
quarantine probe, worktree removal) runs in its own try/catch, and
warnings accumulate in the `OrchestratorRollback` event's payload
(via the orchestrator's `warn()` log). A partial rollback will still
emit the event so operators see the partial state — the warnings are
the diagnostic, not the absence of the event.

The event payload itself carries booleans for each side-effect so
operators can detect a partial rollback without grep'ing logs:

- **`statusReverted`** (AISDLC-186) — `true` when the task file's
  `status:` line was successfully patched back to `fromStatus`. When
  `false`, the task file write failed (file disappeared mid-run,
  frontmatter became unparseable, disk error). Note that `toStatus`
  reports the INTENDED post-rollback status and mirrors `fromStatus`
  even on failure — the on-disk reality is in `statusReverted`. When
  `false`, manually reset the task status (`mcp__backlog__task_edit
  <id> --status <fromStatus>`).
- **`worktreeRemoved`** — `true` when `git worktree remove --force`
  succeeded (or the path was already absent). `false` indicates the
  worktree directory is still on disk + still registered with git.
- **`branchQuarantined`** — `true` when the dev's branch carried
  commits beyond `origin/main` AND the rename to
  `quarantine/<ref>` succeeded. `false` is the common case (no
  commits to preserve) but can also indicate a rename failure —
  cross-reference the warnings to disambiguate.

Common partial-rollback warnings:

| Warning | Cause | Fix |
|---|---|---|
| `task file not found for <id>` | Backlog task file moved/deleted between Step 4 and rollback. | Manual `mcp__backlog__task_edit` to set status. |
| `worktree remove failed: <stderr>` | Worktree directory locked (e.g. an editor has files open) or already unregistered from `git worktree list`. | `git worktree prune` then `rm -rf .worktrees/<id-lower>` manually. |
| `quarantine rename failed: <stderr>` | Target ref already exists (would require two rollbacks for the same task within the same UTC millisecond per AISDLC-186 — practically impossible) or the branch was deleted by an external process between probe + rename. | Inspect `git reflog show ai-sdlc/<id-lower>` to recover the SHA, then `git branch quarantine/<id>-<ts> <sha>`. |

---

## Auto-cleanup of stale worktree branches (AISDLC-224)

When the autonomous orchestrator dispatches a task and Step 3 (`git worktree add`)
fails because the target branch already exists from a prior aborted session, the
orchestrator can self-heal by cleaning up the stale branch and retrying — instead
of returning `{ outcome: 'aborted' }` and re-failing on every subsequent tick.

### Feature flag

Auto-cleanup is **off by default**. Opt in by setting:

```bash
export AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP=1
```

Canonical truthy values: `1`, `true`, `yes`, `on` (case-insensitive). Any other
value (including unset) leaves cleanup disabled and behavior is unchanged from
before AISDLC-224.

The flag only takes effect when the orchestrator is also running in autonomous
mode (i.e., invoked via `cli-orchestrator tick` / `cli-orchestrator start`). The
manual `/ai-sdlc execute` slash command path always leaves `autonomousMode` false
and is unaffected regardless of the flag.

### How it works

When `git worktree add` exits non-zero with a "branch already exists" stderr
pattern, AND `autonomousMode === true`, AND `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP`
is truthy, Step 3 runs **six** safety predicates before attempting any cleanup
(AISDLC-224 introduced predicates 1-3; AISDLC-228 added predicates 4-6 to close
the incident where an active worktree was quarantined mid-attestation-sign):

1. **Open-PR check** — `gh pr list --head <branch> --state open` must return
   empty. An open PR means the operator's in-flight work is associated with this
   branch and clobbering it would destroy review history. Fails **closed** on any
   `gh` error (token expired, network timeout, `gh` not installed).

2. **Uncommitted-changes check** — `git -C <worktree-path> status --porcelain`
   must return empty. Uncommitted changes represent potential data loss if the
   worktree is forcibly removed.

3. **Branch-checked-out-elsewhere check** — `git worktree list --porcelain` must
   NOT show the branch mounted at a different path. If it does, another worktree
   (possibly a parallel dispatch) is actively using the branch.

4. **Unpushed-commits check** (AISDLC-228) — if the branch has commits ahead of
   `origin/main` AND no remote tracking upstream (i.e. not yet pushed at all),
   cleanup is refused. If a tracking upstream is present, `git rev-list --count
   <branch> ^<upstream>` must be 0. This catches the witnessed incident where the
   dev had committed locally but `git push` was still in progress.

5. **Active-sentinel check** (AISDLC-228) — `.worktrees/<task-id-lower>/.active-task`
   must either be absent OR have an mtime older than **6 hours**. A sentinel
   younger than 6 hours means a live pipeline session is using this worktree.

6. **Live-subprocess check** (AISDLC-228) — a portable `ps -ax -o pid,command`
   scan must find no `claude --print` (or `claude -p`) process whose argv
   references the task ID. A live subprocess means the dev subagent is still
   running.

ALL six predicates must pass. If ANY predicate fires, cleanup is skipped and a
`[step-3] <taskId>: keeping branch (<reason>)` trace line is emitted so the
operator can see why (e.g. `active sentinel modified 10min ago`).

When all six pass, the cleanup sequence runs:
1. `git worktree remove --force <.worktrees/<task-id>/>`
2. `git branch -D <branch>`
3. `git worktree add <.worktrees/<task-id>> -b <branch> origin/main` (one retry)
4. If retry also fails → original error is re-raised (no looping)

### WorktreeAutoCleaned event

When cleanup fires, a `WorktreeAutoCleaned` event is emitted on the
`events.jsonl` bus:

```jsonc
{
  "ts": "2026-05-06T12:34:56.789Z",
  "type": "WorktreeAutoCleaned",
  "taskId": "AISDLC-99",
  "branch": "ai-sdlc/aisdlc-99",
  "reason": "branch already exists",
  "hadOpenPR": false,           // always false when cleanup proceeded
  "hadUncommittedChanges": false // always false when cleanup proceeded
}
```

Grep for it:

```bash
jq -c 'select(.type == "WorktreeAutoCleaned")' \
  artifacts/_orchestrator/events-*.jsonl
```

A high frequency of `WorktreeAutoCleaned` events for the same `taskId` across
multiple days indicates the rollback mechanism (AISDLC-177) may not be
completing cleanly — investigate the `OrchestratorRollback` events for that
task to see if worktree removal or branch deletion failed.

### Safety rationale

| Predicate | Signal | What it protects |
|---|---|---|
| Open-PR check | Fail-closed | In-flight operator review — never silently close a PR's source branch |
| Uncommitted-changes check | git status | Potential developer work that wasn't committed before the prior session crashed |
| Branch-checked-out-elsewhere | git worktree list | A parallel dispatch or manual operator session using the same branch |
| Unpushed-commits check | git rev-list | Dev commits that landed but weren't pushed before the orchestrator interrupted |
| Active-sentinel check | `.active-task` mtime | A live pipeline session is mid-flight in the worktree |
| Live-subprocess check | ps -ax | The dev subagent subprocess is still running |

If the auto-cleanup ever misbehaves (e.g. false-negative on an open-PR check due
to a `gh` network failure), the conservative fallback is the pre-AISDLC-224
behavior: the error surfaces, the task gets re-picked on the next tick, and the
operator sees repeated `aborted` outcomes for the same task — noisy but safe.

---

## Worktree quarantine rules (AISDLC-228) {#quarantine-rules}

> **Incident witness (2026-05-07):** The orchestrator's rollback path quarantined
> an active branch mid-attestation-sign. The dev commit (`8f20a42`) and the
> attestation chore (`003496f`) survived only via `git reflog`. This section
> documents the tightened predicate that prevents recurrence.

### When quarantine fires

The AISDLC-177 rollback helper renames a failed-dispatch branch under
`quarantine/<task-id-lower>-<iso-timestamp>` when:

1. The branch has commits beyond `origin/main` (the dev produced work before
   the dispatch failed), AND
2. **ALL four** `isReallyStale()` signals say "stale" (AISDLC-228 tightened
   predicate — previously only signal 1 was checked).

### The `isReallyStale()` predicate

Before renaming, `rollbackDispatch` calls `isReallyStale(taskId, branch)` which
checks four signals in order. The first signal that says "in-flight" short-circuits
the check and quarantine is **skipped**:

| Signal | Check | Stale verdict |
|---|---|---|
| (1) Upstream tracking | `git rev-parse --abbrev-ref <branch>@{upstream}` — if no upstream exists, commits are local-only → NOT stale. If upstream present, `git rev-list --count <branch> ^<upstream>` must be 0. | Not stale if > 0 commits ahead of upstream |
| (2) Active sentinel | `.worktrees/<id-lower>/.active-task` mtime < 6 hours | Not stale if sentinel is fresh |
| (3) Live subprocess | `ps -ax -o pid,command` scan for `claude --print` with task ID in argv | Not stale if subprocess found |
| (4) Open PR | `gh pr list --head <branch> --state open` (fail-closed on gh errors) | Not stale if PR exists |

When quarantine is **skipped**, `rollbackDispatch` also skips the worktree removal
and branch delete steps — the session is actively using them.

### Observability: [step-3] trace lines

Both the auto-cleanup path (Step 3) and the rollback path emit a trace line when
preserving a branch:

```
[step-3] aisdlc-178.4.1: keeping branch (active sentinel modified 12min ago)
[step-3] aisdlc-70: keeping branch (3 commits ahead of origin/ai-sdlc/aisdlc-70 (unpushed))
[step-3] aisdlc-99: keeping branch (open PR #386 for branch ai-sdlc/aisdlc-99)
[step-3] aisdlc-99: keeping branch (live claude --print subprocess for AISDLC-99 (PID 55555))
```

The `quarantineSkippedReason` field is also set in the `OrchestratorRollback`
event payload for forensic use:

```bash
jq -c 'select(.type == "OrchestratorRollback" and .quarantineSkippedReason != null)' \
  artifacts/_orchestrator/events-*.jsonl
```

### Recovery playbook: quarantine fired on active work

If quarantine fired on a branch that was actively in-flight (e.g. before
AISDLC-228 shipped, or if all 4 signals somehow passed), recover with:

**Step 1:** Find the quarantine ref:

```bash
git branch --list 'quarantine/<task-id-lower>-*'
# or from events.jsonl:
jq -c 'select(.type == "OrchestratorWorkQuarantined" and .taskId == "AISDLC-NNN")' \
  artifacts/_orchestrator/events-*.jsonl
```

**Step 2:** Restore the worktree from the quarantine ref:

```bash
# Replace <task-id-lower>, <branch-name>, and <quarantine-ref> with your values.
git worktree add .worktrees/<task-id-lower> -b <branch-name> <quarantine-ref>
```

**Step 3:** Verify the commits are there:

```bash
git -C .worktrees/<task-id-lower> log --oneline --not origin/main
```

**Step 4:** Push the recovered branch and open/re-open the PR:

```bash
git push -u origin <branch-name>
gh pr create --draft --title "recovered: ..." --body "..."
```

**Step 5:** Re-run any review / attestation steps that were interrupted
(the worktree's `.ai-sdlc/verdicts/` and `.ai-sdlc/attestations/` directories
may be intact from before the quarantine fired — check before re-running).

### When quarantine fires correctly (truly stale branch)

When all 4 signals say stale, quarantine is the right action. The
`OrchestratorWorkQuarantined` event documents what was preserved:

```jsonc
{
  "type": "OrchestratorWorkQuarantined",
  "taskId": "AISDLC-70",
  "branch": "ai-sdlc/aisdlc-70",
  "quarantineRef": "quarantine/aisdlc-70-2026-05-04T14-23-44-000",
  "commitSha": "abc1234deadbeef",
  "commitCount": 2
}
```

The task's status is reverted to `To Do` automatically; the next tick re-dispatches
the task. Use the "Recovery playbook" above only if the dev's commits should be
carried forward rather than restarted from scratch.

---

## Counting developer-contract retries by code path (AISDLC-196)

When the developer subagent returns non-JSON prose, the Step 6 retry
helper re-prompts for the JSON envelope and — if the dev recovers — the
orchestrator emits a `DeveloperContractRetry` event onto the
`events.jsonl` bus. Two code paths fire this event:

- **Initial-dispatch path** (`phase: 'initial'`) — Step 5b/6 of
  `executePipeline()`, on the very first dev call for the task.
  Frequent emission here points at developer.md system-prompt drift
  (the agent forgot the JSON contract often enough that the retry is
  doing more work than it should).
- **Iteration-loop path** (`phase: 'iteration'`, plus an `iteration`
  field carrying the actual loop counter, always >=2) — Step 9 of the
  iteration loop, when the dev returns prose on a re-dispatch after a
  CHANGES_REQUESTED round. Frequent emission here points at
  post-feedback re-dispatch fragility (long feedback prompts pushing
  the agent off the contract), not initial-prompt drift.

Operator queries against the date-rotated events files:

```bash
# All DeveloperContractRetry events across every rotated file:
jq -c 'select(.type == "DeveloperContractRetry")' \
  artifacts/_orchestrator/events-*.jsonl

# Iteration-path retries only — surfaces post-feedback re-dispatch drift:
jq -c 'select(.type == "DeveloperContractRetry" and .phase == "iteration")' \
  artifacts/_orchestrator/events-*.jsonl

# Initial-dispatch retries only — surfaces developer.md prompt drift:
jq -c 'select(.type == "DeveloperContractRetry" and .phase == "initial")' \
  artifacts/_orchestrator/events-*.jsonl

# Per-iteration histogram (iteration 2, 3, ... = which feedback round
# tripped the contract most often):
jq -r 'select(.type == "DeveloperContractRetry" and .phase == "iteration") | .iteration' \
  artifacts/_orchestrator/events-*.jsonl | sort | uniq -c
```

The `phase` + `iteration` discriminators are additive (AISDLC-196):
events emitted before the discriminator landed simply omit the fields,
so the queries above implicitly bucket pre-discriminator events into
neither group. Any persistent imbalance between the two paths is the
signal — pick the one with the higher count and address its drift
source first.

---

## Diagnosing `claude --print` subprocess failures (AISDLC-239)

When a developer dispatch returns `developer-json-contract-violated` with
`raw output: ""`, the problem is at the subprocess level — the `claude --print`
process itself exited without producing output. As of AISDLC-239,
`ShellClaudePSpawner` captures full subprocess diagnostics and surfaces them
on the `SubagentResult.subprocessDiagnostics` field.

### New `subprocessDiagnostics` field

Every `ShellClaudePSpawner` invocation now populates:

```ts
interface SubprocessDiagnostics {
  exitCode: number | null;      // process exit code; null when killed by signal
  signal: string | null;        // OS signal that killed the process; null on normal exit
  stderrTail: string;           // last 2 KB of stderr (empty when stderr was clean)
  wallClockMs: number;          // wall-clock spawn → close duration in ms
  argv: readonly string[];      // full argv passed to claude (excludes the binary name)
  failureType?: string;         // machine-readable failure classification (see below)
  watchdogFired?: boolean;      // true when the spawner's own timeout killed the process
}
```

The field is on `SubagentResult` and propagates through the pipeline to the
`PipelineFailureDetail.type` and outcome `notes` fields when a dispatch fails.

### Failure-type taxonomy

| `failureType` | `PipelineFailureDetail.type` | Meaning | Next action |
|---|---|---|---|
| `claude-cli-api-error` | `claude-cli-api-error` | Exit != 0 AND stderr matches an Anthropic API error pattern (`authentication_error`, `rate_limit`, `overloaded_error`, `api_error_status`, `invalid_request_error`). | Check `stderrTail`. If `authentication_error` → re-login (`claude auth`). If `rate_limit` → backoff and retry. If `overloaded_error` → retry later. |
| `claude-cli-empty-output-fast` | `claude-cli-empty-output-fast` | Exit 0, stdout empty, wall-clock < 5 s. The CLI quit before the session started. | Run `claude auth status` to check login state. Re-login if needed (`claude auth`). |
| `claude-cli-killed` | `claude-cli-killed` | Process was killed by a signal. `signal` carries the signal name; `watchdogFired=true` means the orchestrator's 30-min timeout fired; `watchdogFired=false` means an external kill (OOM, operator). | If `watchdogFired=true` and the task is consistently slow, increase the spawner's `defaultTimeoutMs`. If an OOM kill, investigate memory pressure. |
| `claude-cli-nonzero-exit` | `developer-json-contract-violated` (fallback) | Non-zero exit without a recognised API error pattern. | Read `stderrTail` for the raw error. Common causes: plugin not loaded, misconfigured agent name. |
| `claude-cli-spawn-error` | `developer-json-contract-violated` (fallback) | `spawn()` itself threw (e.g. `ENOENT` — `claude` binary not on PATH). | Install the Claude Code CLI: `npm i -g @anthropic-ai/claude-code`. |
| `claude-cli-watch-error` | `developer-json-contract-violated` (fallback) | Child process emitted an `error` event (network error, process crash). | Check `stderrTail` and system logs. |
| _(absent)_ | (as-is) | Exit 0, non-empty stdout — happy path OR `claude-cli-empty-output-fast` not triggered because `wallClockMs >= 5000`. | No action needed on success; on `wallClockMs >= 5000` + empty stdout — inspect `stderrTail`. |

### Reading diagnostics in log output

The spawner emits a human-readable summary when a dispatch fails. Look for
lines like:

```
[ai-sdlc-progress] execute: outcome=developer-json-contract-violated pr=none iterations=1
```

To see the full `subprocessDiagnostics` payload, inspect the `TaskDispatchOutcome`
in the tick result (printed as JSON to `cli-orchestrator tick` stdout):

```json
{
  "taskId": "AISDLC-99",
  "outcome": "developer-json-contract-violated",
  "prUrl": null,
  "failure": {
    "type": "claude-cli-api-error",
    "message": "claude -p exited with code 1"
  },
  "notes": "developer subagent violated JSON envelope contract..."
}
```

Or from events.jsonl (Phase 4):

```bash
jq -c 'select(.type == "OrchestratorFailed")' \
  artifacts/_orchestrator/events-*.jsonl
```

### Reproducing a controlled failure for diagnostics verification

To verify the new diagnostic fields are working without a live dispatch, trigger
a controlled failure by using an invalid model name:

```bash
AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental \
  node pipeline-cli/bin/cli-orchestrator.mjs tick \
  --max-concurrent 1 --max-ticks 1
```

Or drive the spawner directly in a test context (using the injected fake spawn):

```ts
// Simulate an auth error
const { fake } = makeFakeSpawn({
  stderr: '{"error":{"type":"authentication_error","message":"invalid key"}}',
  code: 1,
});
const spawner = new ShellClaudePSpawner({ spawn: fake });
const result = await spawner.spawn({ type: 'developer', prompt: '...', cwd: '.' });
console.log(result.subprocessDiagnostics);
// => { exitCode: 1, signal: null, stderrTail: '...authentication_error...', failureType: 'claude-cli-api-error', ... }
```

### AC #6 — controlled repro observation (AISDLC-239)

The original dogfood incident (2026-05-07) showed both parallel `claude --print`
dispatches returning empty stdout. With the new diagnostics instrumented, the
same failure would now surface one of:

- `claude-cli-empty-output-fast` — if the subprocess exited in < 5 s with code 0.
  Most likely culprit for the parallel-empty-output incident: the CLI quit
  immediately (auth/config check), stdout was never written.
- `claude-cli-api-error` — if `stderrTail` shows an Anthropic API error
  (e.g. `overloaded_error` under heavy load when two parallel sessions both
  hit the subscription's concurrent-session limit).

The diagnosis without instrumentation was impossible. With `stderrTail`,
`exitCode`, and `wallClockMs`, the root cause is machine-readable in the outcome
envelope. AC #7 (fix-after-diagnosis) is deferred until a live repro surfaces
the actual `failureType` — speculative fixes without evidence are explicitly
out of scope per the task brief.

---

## Worktree mutex — preventing `.git/config.lock` races (AISDLC-241)

When the orchestrator dispatches more than one task in parallel, concurrent
`git worktree add` invocations race on `.git/config.lock`. The symptom is a
hard failure during Step 3:

```
fatal: Unable to create '.git/config.lock': File exists
```

This is fixed in AISDLC-241 by serializing all `git worktree add` (and the
cleanup siblings `git worktree remove` + `git branch -D`) through an
in-process promise-queue backed by an advisory file lock at
`.git/.ai-sdlc-worktree-mutex`.

### How the lock works

Two layers of protection:

1. **In-process promise queue** — all callers within the same Node.js process
   share a singleton chain. When `withWorktreeMutex()` is called concurrently,
   callers queue behind the current holder and run one at a time.

2. **Cross-process file lock** — a directory at `.git/.ai-sdlc-worktree-mutex`
   is created atomically (`mkdir`) by the holder and removed on release. This
   protects against two independently started `cli-orchestrator tick` processes.

The lock has a 60-second timeout. If the mutex cannot be acquired within 60s,
the caller receives:

```
Error: worktree mutex held > 60s — likely a stuck previous tick;
investigate `.git/.ai-sdlc-worktree-mutex` mtime
```

### Clearing a stuck mutex

A stuck mutex can occur if the orchestrator process was killed with `SIGKILL`
(not `SIGTERM` or `SIGINT`) while inside the critical section, or if the
process crashed before the `finally` block ran.

**Check if the file lock is held:**

```bash
ls -la .git/.ai-sdlc-worktree-mutex
```

If the directory exists and the owning process is no longer running, remove it
manually:

```bash
rmdir .git/.ai-sdlc-worktree-mutex
```

**Verify no stale `.git/config.lock` remains:**

```bash
ls -la .git/config.lock
# If present, inspect its age:
stat .git/config.lock
# Remove if the owning process is gone:
rm .git/config.lock
```

**Check that no `git worktree` operation is currently running:**

```bash
ps aux | grep 'git worktree'
```

Once the stale lock is removed, the next orchestrator tick will proceed
normally.

### Observability

The worktree mutex does not emit events to `events.jsonl` (it is a
low-level runtime primitive). If you suspect mutex contention is causing
slow ticks, check:

1. The mtime of `.git/.ai-sdlc-worktree-mutex` to estimate how long the
   current holder has been running.
2. The orchestrator log for `OrchestratorDispatched` events — a cluster of
   events with similar timestamps indicates parallel dispatches that queued
   behind the mutex.

### Signal safety

`setupWorktreeSignalHandler(workDir)` is called once per orchestrator
process start. It installs a `SIGINT` / `SIGTERM` listener that releases
the file lock before re-raising the signal, so a clean `Ctrl-C` leaves no
stale `.git/.ai-sdlc-worktree-mutex` on disk. A `SIGKILL` bypasses the
handler — manual cleanup (above) is required in that case.

---

## Resume from interrupted orchestrator runs (AISDLC-242)

Long Tier-2 tasks (12+ ACs, 30+ files) take 20-30 minutes of dev subagent
time. Losing that work to a kill signal, watchdog timeout, network blip, or
operator Ctrl-C is expensive. The resume protocol preserves partial dev work
so the next tick picks up where the previous session left off.

### How it works

When the `cli-orchestrator tick` dispatcher returns `outcome: 'aborted'`
(the outcome set when a dev subagent is killed by SIGTERM/SIGKILL or the
30-min watchdog fires), the orchestrator classifies the abort as
**RECOVERABLE** instead of rolling back:

1. **Worktree preserved**: `.worktrees/<task-id-lower>/` is left on disk
   with the dev's partial changes intact.
2. **Branch preserved**: the dev's branch (`ai-sdlc/<task-id-lower>-...`)
   is not quarantined or deleted.
3. **Sentinel preserved**: `.active-task` sentinel stays in place so the
   in-flight filter recognises the worktree on restart.
4. **Event emitted**: `OrchestratorTaskAbortedRecoverable` is written to
   `events.jsonl` with the abort reason, branch name, and commit counts
   (including any `wip(checkpoint):` commits).

On the **next tick**, the orchestrator detects the existing worktree and
emits `OrchestratorTaskResumed` before re-dispatching the task. The dev
subagent dispatched by that tick finds the worktree already populated and
continues from the current HEAD instead of starting from scratch.

### Checkpoint commits (Mechanism 1)

The dev agent can emit periodic `wip(checkpoint):` commits to preserve
partial work in git history:

```bash
# Inside the worktree — the orchestrator checkpoint helper does this:
git add -A
git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): after editing step-7 files (AISDLC-242)"
```

These commits are intentionally exempt from pre-commit hooks (`--no-verify`)
because:
- The working diff may be incomplete (tests don't pass yet).
- Coverage, drift, and attestation hooks are not meaningful mid-edit.

Before the final push, checkpoint commits are squashed into the real commit
via `git rebase --autosquash`, so they never appear in PR history.

To inspect checkpoint commits in a preserved worktree:

```bash
git -C .worktrees/<task-id-lower> log --oneline --grep="^wip(checkpoint):" origin/main..HEAD
```

### Stale worktree sweep policy

A recoverable worktree older than **24 hours** is considered stale and
is eligible for automatic discard. The sweep policy is:

- Age is measured from the sentinel's mtime (last write = last dev activity).
- Worktrees with an open PR are never swept automatically — they follow the
  PR lifecycle instead.
- Worktrees with a live `claude --print` subprocess are never swept.

To list all preserved worktrees and their ages:

```bash
find .worktrees -name '.active-task' -maxdepth 2 | while read p; do
  dir=$(dirname "$p")
  age=$(( ( $(date +%s) - $(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p") ) / 3600 ))
  echo "${age}h old: $dir ($(cat $p))"
done
```

### Manually resuming a task

If you want to force a resume immediately (rather than waiting for the next
scheduled tick):

```bash
# Option 1: run a single tick now (picks up the preserved worktree automatically)
AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental \
  node pipeline-cli/bin/cli-orchestrator.mjs tick

# Option 2: open the worktree interactively and continue development yourself
cd .worktrees/<task-id-lower>
git log --oneline origin/main..HEAD  # inspect checkpoint commits
# make additional edits, then push normally
```

### Manually discarding a recoverable worktree

If the partial work is no longer needed (e.g. the task spec changed
significantly and a clean dispatch is preferable):

```bash
# 1. Remove the worktree
git worktree remove --force .worktrees/<task-id-lower>

# 2. Delete the stale branch
git branch -D ai-sdlc/<task-id-lower>-<branch-suffix>

# 3. Revert the task status to "To Do"
#    (edit the frontmatter in backlog/tasks/<task-file>.md)
#    status: To Do

# 4. The next tick will dispatch the task fresh.
```

### Observability

Recoverable aborts and resumes both write to `events.jsonl`:

```bash
# See all recoverable aborts
grep '"OrchestratorTaskAbortedRecoverable"' artifacts/_orchestrator/events-*.jsonl | \
  jq -r '. | "\(.ts) \(.taskId) reason=\(.reason) commits=\(.commitCount)"'

# See all resumed dispatches
grep '"OrchestratorTaskResumed"' artifacts/_orchestrator/events-*.jsonl | \
  jq -r '. | "\(.ts) \(.taskId) checkpoints=\(.checkpointCommits) total=\(.commitCount)"'
```

### Session-id resume (Mechanism 2 — future work)

`claude --print --session-id <id>` was investigated (AISDLC-242) to determine
whether a killed Claude Code session could be resumed by re-attaching to the
previous conversation ID. Empirical testing against the installed CLI shows:

- `claude --print --session-id` exists as a flag but restarting a session
  by ID starts a **new conversation** pre-seeded with the previous session's
  context window. This is not a true resume — the model re-derives intent from
  context rather than continuing a live session state.
- The flag does not resume from a mid-tool-call state (the killed session's
  in-progress `Edit` or `Write` call is not retried).
- Claude Code's remote sandbox model (CCR) does not expose session-id
  semantics at all for `--print` mode.

**Conclusion**: session-id resume is NOT the right primitive for this use
case. Mechanism 1 (checkpoint commits) + Mechanism 4 (preserve worktree) is
the correct combination: the dev subagent on resume reads the preserved
worktree's git history to understand what was accomplished, then continues
from the current HEAD without needing to restart from scratch.
