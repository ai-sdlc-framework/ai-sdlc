# `cli-deps` snapshot artifact + dispatcher composition (RFC-0014 Phase 1 + 2)

The dependency-graph snapshot artifact is the bridge from AISDLC-117's
in-memory graph (see `pipeline-cli/docs/dependency-graph.md`) to the
RFC-0014 composition layers — depth-aware PPA priority (Phase 2 — this
page), DoR blast-radius surfacing (Phase 3), and Slack/dashboard digests
(Phase 4). All phases ship behind the shared `AI_SDLC_DEPS_COMPOSITION`
feature flag; Phase 1 + 2 are live, Phase 3+ remain future-facing.

This page covers:

- The on-disk shape (one JSONL line per task, schema in
  `spec/schemas/deps-snapshot.v1.schema.json`).
- The `cli-deps {snapshot,gc,inspect}` workflow.
- The `AI_SDLC_DEPS_COMPOSITION` feature flag.
- The "best-effort consistency, validated by consumer" contract per
  RFC-0014 §12 Q6.
- **Phase 2** — `effectivePriority` + the depth-aware dispatcher
  comparator that re-orders `cli-deps frontier` per RFC-0014 §5 + §12 Q1.

## Feature flag — `AI_SDLC_DEPS_COMPOSITION`

Phase 1 ships behind a feature flag (RFC-0014 §9). Until the flag is
explicitly truthy (`1` / `true` / `yes` / `on`, case-insensitive), the
writer is a no-op:

```bash
$ cli-deps snapshot --tag rolling
{
  "ok": true,
  "written": false,
  "reason": "AI_SDLC_DEPS_COMPOSITION is OFF — snapshot skipped (set to 1 to enable)",
  "tag": "rolling"
}
```

Flip it on when you want snapshots to materialise:

```bash
$ AI_SDLC_DEPS_COMPOSITION=1 cli-deps snapshot --tag rolling
{
  "ok": true,
  "written": true,
  "path": "/abs/path/to/artifacts/_deps/snapshot.2026-05-02T11-37-04.123Z.rolling.jsonl",
  "tag": "rolling",
  "recordCount": 142,
  "bytes": 28471
}
```

Phase 5 (RFC-0014 §11) will promote the flag to default-on after a
corpus-driven soak window — the operator runbook for that promotion
lives at `docs/operations/deps-composition.md`.

## Snapshot record shape

Each line is one JSONL record, validated against
[`spec/schemas/deps-snapshot.v1.schema.json`](../../spec/schemas/deps-snapshot.v1.schema.json):

```jsonc
{
  "id": "AISDLC-117",                              // canonical task ID
  "dependencies": ["AISDLC-100.1", "AISDLC-100.3"], // forward edges
  "dependents": ["AISDLC-118"],                    // reverse edges
  "depth": 2,                                       // longest BACKWARD chain
  "criticalPathLength": 5,                          // longest FORWARD chain
  "externalDependencies": [
    {
      "id": "npm-foo-2.0",
      "description": "wait for foo v2 to publish",
      "kind": "npm-version",
      "resolverHint": "registry.npmjs.org/foo"
    }
  ],
  "lastModified": "2026-04-30T17:14:09.871Z"        // file mtime, best-effort
}
```

Field semantics:

- **`depth`** — longest chain length back from this task via the
  `dependencies` edge set (RFC-0014 §4.1). A task with no dependencies
  has `depth: 0`. The deeper the chain, the more upstream work has
  already happened.

- **`criticalPathLength`** — longest chain length forward via the
  reverse edges. Per RFC-0014 §12 Q1 this is the secondary tiebreak
  the dispatcher applies after `effectivePriority` and before recency.
  Leaf tasks (nothing depends on them) have `criticalPathLength: 0`.

- **`externalDependencies`** — RFC-0014 §8 + Q3 — out-of-graph blockers
  declared in the task's frontmatter. Pure signal in v1: surfaced in
  this snapshot, in `cli-deps blockers`, and (Phase 3) in the DoR
  comment. The dispatcher does **not** block on them.

  The `kind` enum is intentionally pre-staged for a future v2 that adds
  per-kind resolvers; today the parser normalises any unknown value to
  `other` rather than dropping the entry.

  Authors declare externals in the task frontmatter:

  ```yaml
  ---
  id: AISDLC-200
  externalDependencies:
    - id: npm-foo-2.0
      description: 'wait for foo v2 to publish'
      kind: npm-version
      resolverHint: foo
    - id: pr-bar-7
      description: 'wait for bar PR #7'
      kind: github-pr
  ---
  ```

- **`lastModified`** — ISO-8601 mtime of the on-disk task file at
  snapshot time. Best-effort: empty string if the stat failed (the
  file moved between graph build and serialisation, per the consistency
  contract below).

## Subcommands

### `cli-deps snapshot --tag <name>`

Materialise the current graph as JSONL. The filename embeds the
ISO-8601 timestamp (with `:` rewritten to `-` for NTFS friendliness)
and the tag suffix:

```
$ARTIFACTS_DIR/_deps/snapshot.2026-05-02T11-37-04.123Z.rolling.jsonl
```

Tags drive retention (see `gc` below). Per RFC-0014 §12 Q2:

| Tag                     | Retention                                  | When to use                                   |
| ----------------------- | ------------------------------------------ | --------------------------------------------- |
| `rolling`               | trimmed by mtime > 30d                     | per-pipeline-tick snapshots                   |
| `dispatch`              | kept indefinitely                          | snapshot at a `/ai-sdlc execute` decision     |
| `calibration`           | kept indefinitely                          | snapshot at a DoR rubric calibration revision |
| `lifecycle-transition`  | kept indefinitely                          | snapshot at an RFC `Lifecycle:` change        |

### `cli-deps gc [--max-age-days N]`

Trim rolling-tagged snapshots older than the cutoff (default 30 days).
Event-tagged snapshots (`dispatch` / `calibration` /
`lifecycle-transition`) are preserved regardless of age.

```bash
$ cli-deps gc
{
  "ok": true,
  "trimmedCount": 47,
  "keptCount": 12,
  "bytesFreed": 1834291,
  "trimmed": ["/abs/.../snapshot.2026-04-01T...rolling.jsonl", ...]
}
```

Run this from the same scheduler that runs other artifact GC (e.g. the
pipeline tick driver) — it's idempotent and tolerant of missing
directories. Per-tag caps (`--keep-last-N` for the permanent tier) are
deliberately deferred to a future revision per RFC-0014 §12 Q2.

### `cli-deps inspect [--tag <name>]`

Enumerate snapshots, optionally filtered by tag. Sorted by embedded
ISO timestamp ascending so the most recent appears last.

```bash
$ cli-deps inspect --tag dispatch --format table
Timestamp                       Tag       Records  Bytes
------------------------------  --------  -------  -------
2026-04-15T03:12:51.420Z        dispatch  138      27314
2026-04-22T09:01:08.011Z        dispatch  142      28471
2026-04-29T17:55:42.103Z        dispatch  149      29710

$ cli-deps inspect --tag dispatch
{
  "ok": true,
  "snapshots": [
    {"path": "...", "file": "...", "isoTimestamp": "...", "tag": "dispatch", "size": 27314, "recordCount": 138},
    ...
  ]
}
```

The output is what an operator uses to decide whether the permanent
tier needs pruning (per RFC-0014 §12 Q2 there's no automatic per-tag
cap in v1).

## Consistency contract — RFC-0014 §12 Q6

The snapshot writer follows a **best-effort consistency, validated by
consumer** contract. Specifically:

- `buildDependencyGraph` walks `backlog/tasks/` + `backlog/completed/`
  sequentially and reads each task file atomically (each `readFile` is
  OS-atomic).
- If an operator edits a task's `dependencies:` field (or moves a file
  between `tasks/` and `completed/`) between the start of the walk and
  the end, the resulting snapshot MAY include task A in pre-edit state
  and task B in post-edit state.
- That can produce a **dangling edge** — `A.dependencies: [X]` where
  `X` no longer exists. The snapshot writer doesn't try to enforce
  consistency at write time; instead, the consumer is expected to
  validate.

The validating consumer is `cli-deps validate`:

```bash
$ cli-deps validate
{"ok": false, "cycles": [], "dangling": [{"source": "AISDLC-A", "missing": "AISDLC-X"}]}
```

Dispatch loops (Phase 2) consult `cli-deps preflight <task-id>` before
acting on a snapshot, so a dangling edge surfaces as a refusal rather
than a wrong dispatch decision.

The contract is honest about scaling: at larger task counts the read
window grows linearly, so a "point-in-time snapshot" framing would
actually be a fiction. The Q6 resolution explicitly chose this contract
over (B) cross-process flock and (D) read-then-validate-then-retry.

## Library API

For programmatic consumers, the snapshot helpers are exported alongside
the dependency-graph functions from `@ai-sdlc/pipeline-cli/deps`:

```ts
import {
  buildDependencyGraph,
  computeSnapshotRecords,
  gcRollingSnapshots,
  inspectSnapshots,
  isCompositionEnabled,
  writeSnapshot,
} from '@ai-sdlc/pipeline-cli/deps';

if (isCompositionEnabled()) {
  const { path, recordCount } = writeSnapshot('dispatch', { workDir: process.cwd() });
  console.log(`wrote ${recordCount} records to ${path}`);
}
```

See `pipeline-cli/src/deps/snapshot.ts` for the full type reference.

## Phase 2 — depth-aware dispatcher composition (AISDLC-167.2)

Phase 2 ships the **PPA × Graph composition** described in RFC-0014 §5.
It re-orders the output of `cli-deps frontier` so a low-priority leaf
that unblocks a critical chain bubbles to the top of the dispatch
queue automatically. Per-task PPA scores are **unchanged** — the
composition is read-only for PPA per RFC-0014 §5.3; only the
dispatcher's sort order is affected.

### `effectivePriority` definition

For a task `T` with priority `priority(T)` (read from the Backlog.md
`priority:` frontmatter — `low | medium | high | critical` mapped to
`1 | 2 | 3 | 4` with default `2` for missing/unknown values):

```
effectivePriority(T) = max(
  priority(T),
  max(priority(D) for D in transitive_downstream(T))
)
```

Where `transitive_downstream(T)` is the closure of the reverse edge set
(every task that depends on `T`, directly or via a chain). Per RFC-0014
§5.3 the aggregation is `MAX`, **not sum** — a 20-task chain doesn't
get a 20× boost.

### Sort order — RFC-0014 §12 Q1

When `AI_SDLC_DEPS_COMPOSITION` is ON, `cli-deps frontier` sorts by:

1. `effectivePriority` DESC (primary)
2. `criticalPathLength` DESC (secondary — structural signal dominates
   arbitrary signal when effective priority ties)
3. `lastModified` DESC (tertiary — newer file wins on full tie)
4. `id` ASC (final — keeps output deterministic)

When `AI_SDLC_DEPS_COMPOSITION` is OFF (the default), `cli-deps
frontier` returns the baseline `id`-ASC order from `frontier()` —
exactly the pre-Phase-2 behaviour. Operators can A/B compare the two
modes inside one process via the `forceComposition` / `forceBaseline`
options on `sortFrontierByEffectivePriority` (see Library API below).

### Output shape — flag ON vs OFF

The JSON shape is **stable across the flag** so consumers don't have
to branch:

```jsonc
{
  "ok": true,
  "compositionEnabled": true,            // mirrors the env flag for transparency
  "frontier": [                          // backwards-compat: same shape pre-Phase-2
    { "id": "AISDLC-DROOT", "title": "...", "dependencies": [] },
    { "id": "AISDLC-SROOT", "title": "...", "dependencies": [] },
    { "id": "AISDLC-ALONE", "title": "...", "dependencies": [] }
  ],
  "ranked": [                            // new: same order as `frontier`, with metadata
    {
      "id": "AISDLC-DROOT",
      "title": "...",
      "dependencies": [],
      "basePriority": 2,                 // medium — what the author wrote
      "effectivePriority": 4,            // critical — inherited from a critical leaf
      "criticalPathLength": 2,           // 2 forward steps to the deepest leaf
      "lastModified": "2026-04-30T17:14:09.871Z"
    },
    ...
  ]
}
```

`frontier[0]` is always the dispatcher's first pick — old consumers
that index `frontier[0]` automatically benefit from the composition
without any code change.

`--format table` renders the same data as columns:

```
$ AI_SDLC_DEPS_COMPOSITION=1 cli-deps frontier --format table
ID            Title             EffPri  CPL  Dependencies (all completed)
------------  ----------------  ------  ---  ----------------------------
AISDLC-DROOT  d-root            4       2    (none)
AISDLC-SROOT  s-root            3       1    (none)
AISDLC-ALONE  alone             2       0    (none)
```

### No cache — RFC-0014 §12 Q4

`computeEffectivePriorities` recomputes from scratch every call. At
current scale (~150 tasks, ~200 edges) the two memoised DFS passes
total sub-millisecond. Adding a TTL cache would invite invalidation
bugs (stale cache → wrong dispatch decision) for negative measured
benefit; revisit only if profiling under realistic load shows
recompute > 5% of decision time.

### Monotonicity

Adding a new dependency edge can only INCREASE the effective priority
of upstream tasks, never decrease it (max-aggregation is idempotent).
This is asserted in `effective-priority.test.ts` and lets operators
reason about the sort order across edits without surprise inversions.

### Library API (Phase 2)

```ts
import {
  buildDependencyGraph,
  computeEffectivePriorities,
  frontier,
  isCompositionEnabled,
  rankAllByEffectivePriority,
  sortFrontierByEffectivePriority,
} from '@ai-sdlc/pipeline-cli/deps';

const g = buildDependencyGraph({ workDir: process.cwd() });

// Pure record set — useful for dashboards, soak A/B comparison, etc.
const records = computeEffectivePriorities(g);

// Re-rank the ready frontier (honours the env flag).
const ranked = sortFrontierByEffectivePriority(g, frontier(g));

// Force ON regardless of env (e.g. soak mode).
const composed = sortFrontierByEffectivePriority(g, frontier(g), {
  forceComposition: true,
});

// Whole-graph sort, not just the ready frontier.
const everything = rankAllByEffectivePriority(g);
```

See `pipeline-cli/src/deps/effective-priority.ts` and
`pipeline-cli/src/deps/dispatch.ts` for the full type reference.

## What Phase 2 deliberately doesn't ship

Per RFC-0014 §11 the following are scheduled for later phases:

- **DoR comment template extension** (Phase 3 — blast-radius callout).
- **Slack digest + dashboard graph view** (Phase 4).
- **Soak + flag promotion** (Phase 5 — corpus-driven, not calendar-gated).

The snapshot artifact (Phase 1) and the dispatcher composition
(Phase 2) are both live, both behind `AI_SDLC_DEPS_COMPOSITION`. The
Phase 4 dashboard will consume the same `effectivePriority` records
this page documents; the Phase 3 DoR template will read `dependents`
from the snapshot to compute blast-radius.
