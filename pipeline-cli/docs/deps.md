# `cli-deps` snapshot artifact + dispatcher + DoR composition (RFC-0014 Phase 1 + 2 + 3 + 5)

The dependency-graph snapshot artifact is the bridge from AISDLC-117's
in-memory graph (see `pipeline-cli/docs/dependency-graph.md`) to the
RFC-0014 composition layers — depth-aware PPA priority (Phase 2),
DoR blast-radius surfacing (Phase 3 — this page also documents),
Slack/dashboard digests (Phase 4), and the corpus-driven promotion
infrastructure (Phase 5 — also documented here). All phases ship
behind the shared `AI_SDLC_DEPS_COMPOSITION` feature flag; Phases
1 + 2 + 3 + 5 are live, Phase 4 remains future-facing.

This page covers:

- The on-disk shape (one JSONL line per task, schema in
  `spec/schemas/deps-snapshot.v1.schema.json`).
- The `cli-deps {snapshot,gc,inspect}` workflow.
- The `AI_SDLC_DEPS_COMPOSITION` feature flag.
- The "best-effort consistency, validated by consumer" contract per
  RFC-0014 §12 Q6.
- **Phase 2** — `effectivePriority` + the depth-aware dispatcher
  comparator that re-orders `cli-deps frontier` per RFC-0014 §5 + §12 Q1.
- **Phase 3** — DoR blast-radius callouts + calibration log extension
  + `cli-dor-corpus --blast-radius` per RFC-0014 §6 + §12 Q5.
- **Phase 5** — corpus aggregator (`cli-deps-corpus`), operator
  override capture (`cli-deps log-override` + `cli-deps list-overrides`),
  and the hybrid corpus-OR-override promotion path that flips the
  flag's default OFF → ON per RFC-0014 §11.

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

## What's not yet shipped

Per RFC-0014 §11 the following remains scheduled for a later phase:

- **Slack digest + dashboard graph view** (Phase 4 / AISDLC-167.4).

The snapshot artifact (Phase 1), the dispatcher composition (Phase 2),
the DoR composition (Phase 3), and the corpus-driven promotion
infrastructure (Phase 5 — see below) are all live, all behind
`AI_SDLC_DEPS_COMPOSITION`. The Phase 4 dashboard will consume the
same `effectivePriority` records this page documents, the same
blast-radius helpers Phase 3 ships, and the same override log Phase 5
captures.

## Phase 3 — DoR composition (AISDLC-167.3, RFC-0014 §6)

Phase 3 wires the snapshot artifact into the Definition-of-Ready
clarification comment + calibration log so authors see "this gates N
downstream tasks" and the calibration loop can distinguish
false-positives on graph leaves (low cost) from false-positives on
chain roots (high cost). Like Phase 1, every Phase 3 surface is gated
on `AI_SDLC_DEPS_COMPOSITION` — when the flag is OFF the comment + log
shape match the RFC-0011 baseline byte-for-byte.

### Comment templates

Two templates fire depending on the admission verdict source (per
RFC-0014 §12 Q5 resolution):

#### Standard verdict (`needs-clarification` from rubric evaluation)

The clarification comment gains an additional callout block when the
target's blast radius is > 0 (graph leaves get no callout — there's no
point telling the author "this gates 0 tasks"):

```
> ⚠ This issue currently gates 7 downstream tasks (AISDLC-101, AISDLC-102, AISDLC-103, ...). Resolving the questions above unblocks the entire chain.
```

For high-radius issues (>10 downstream), the listed ids cap at 10 and
the rest fold into "(and N more)".

#### Bypass verdict (`dor-bypass` maintainer override)

A separate maintainer-tone FYI comment fires when `dor-bypass` is
applied to a high-radius task (configurable threshold; default 3):

```
> ℹ This bypass admits a task gating 5 downstream items (AISDLC-101, AISDLC-102, AISDLC-103, AISDLC-104, AISDLC-105). Confirm intentional — high blast radius is a strong calibration signal that the rubric may be missing something.
```

Different audience (the maintainer who applied the bypass), different
tone (FYI not "do this"), same data. Pairs naturally with RFC-0011
§7.4's per-maintainer override-rate metric.

### External-deps callout (Q3 resolution)

The clarification comment also appends `> ⚠ External dependencies
tracked: N` when the task's `externalDependencies:` frontmatter is
non-empty. Pure signal in v1; the dispatcher does not block on
externals.

### Calibration log extension

Each entry in `$ARTIFACTS_DIR/_dor/calibration.jsonl` gains two
optional fields:

```jsonc
{
  // ... existing fields ...
  "blastRadius": {
    "count": 7,
    "downstreamSampleIds": ["AISDLC-101", "AISDLC-102", "AISDLC-103", "AISDLC-104", "AISDLC-105"]
  },
  "highestDownstreamPriority": 85
}
```

The sample is capped at 5 ids per entry to keep the JSONL line tight;
the full closure is rebuildable from the snapshot. Backward-compatible
— existing readers (`cli-dor-stats`, `cli-dor-corpus`) ignore unknown
fields gracefully.

### `cli-dor-corpus --blast-radius`

The corpus aggregator gains a `--blast-radius` flag that attaches a
distribution to the JSON envelope (and renders an extra section under
`--format table`):

```bash
$ cli-dor-corpus aggregate ./downloaded --blast-radius --format table
# (per-gate FP-rate table omitted)

Blast-radius distribution (RFC-0014 Phase 3) — withRadius=120, withoutRadius=0
bucket           n   overrides  needs-clarif
---------------  --  ---------  ------------
leaf (0)         62  3          0
shallow (1-2)    34  4          12
medium (3-5)     14  5          14
deep (6-10)      7   3          7
critical (11+)   3   1          3

Per-gate distribution:
  gate-1: meanRadius=4.2 maxRadius=18
    leaf (0)         n=22  overrides=2  needs-clarif=0
    shallow (1-2)    n=14  overrides=2  needs-clarif=12
    medium (3-5)     n=8   overrides=2  needs-clarif=8
    deep (6-10)      n=3   overrides=1  needs-clarif=3
    critical (11+)   n=2   overrides=1  needs-clarif=2
```

Buckets:

- `leaf (0)` — graph leaves; no comment callout fires
- `shallow (1-2)` — below the default Q5 bypass threshold (3)
- `medium (3-5)` — default bypass-FYI threshold tier
- `deep (6-10)` — chain depth that warrants attention
- `critical (11+)` — chain root; rubric tuning candidate

Entries lacking the `blastRadius` field (older entries pre-Phase 3)
count toward `withoutRadius` and are skipped from the histograms — the
bucket math stays clean as the corpus rolls forward.

### `dor-config.yaml` — `blastRadiusThreshold`

The Q5 bypass FYI threshold is per-project tunable:

```yaml
spec:
  # ... other fields ...
  # RFC-0014 §12 Q5 — bypass FYI fires only when blast radius >= this.
  # Default 3; raise on noisier projects, lower on a project where
  # every task is structurally part of a chain.
  blastRadiusThreshold: 5
```

Schema-validated against [`spec/schemas/dor-config.v1.schema.json`](../../spec/schemas/dor-config.v1.schema.json).

### Library API

```ts
import {
  blastRadiusForCalibration,
  computeBlastRadius,
  renderBypassBlastRadiusComment,
  renderClarificationComment,
} from '@ai-sdlc/pipeline-cli';
import { computeSnapshotRecords, buildDependencyGraph } from '@ai-sdlc/pipeline-cli';

// In your DoR ingress shim:
const records = computeSnapshotRecords(buildDependencyGraph({ workDir }));
const radius = computeBlastRadius(taskId, records);

// Standard `needs-clarification` flow:
const body = renderClarificationComment(verdict, {
  blastRadius: radius,
  externalDependencyCount: task.externalDependencies.length,
});

// `dor-bypass` flow (separate comment, only when threshold met):
const fyi = renderBypassBlastRadiusComment(taskId, radius, {
  highRadiusThreshold: dorConfig.blastRadiusThreshold,
});
if (fyi) await poster.create(fyi);

// Calibration log:
appendCalibrationEntry({
  verdict,
  blastRadius: blastRadiusForCalibration(radius),
});
```

See `pipeline-cli/src/dor/blast-radius.ts` for the full type reference.
The renderers + library helpers are pure (no I/O); the consumer
(typically `evaluateAndCommentBacklogTaskClaude` in
`ingress-claude.ts`) is the integration point for stitching snapshot →
verdict → comment → log.

## Phase 5 — soak corpus + hybrid promotion (AISDLC-167.5, RFC-0014 §11)

Phase 5 ships the measurement infrastructure that closes the RFC-0014
loop: aggregator + override capture + runbook. The actual flag flip
(default OFF → ON) is operator-decision-gated and lives in
[`docs/operations/deps-composition-promotion.md`](../../docs/operations/deps-composition-promotion.md);
this page documents the CLI surface that runbook drives.

### Soak measurement methodology

Per RFC-0014 §11 Phase 5 the promotion criteria are corpus-driven, not
calendar-gated:

- **Dispatch correctness > 95%** (composition top-of-frontier matches
  the baseline top-of-frontier across the snapshot corpus), AND
- **No operator override-rate spike** (operators aren't routinely
  picking past the dispatcher's top — measured via the override log).

The aggregator computes both signals from the canonical surfaces this
page documents. The same pattern carries forward to any future phase
that needs a corpus-driven exit criterion (mirror of RFC-0011 / AISDLC-161).

### Operator override capture — `cli-deps log-override`

When an operator dispatches a task that ISN'T the dispatcher's
top-of-frontier, the override is logged so the next aggregator run
can incorporate the signal:

```bash
$ cli-deps log-override --picked AISDLC-XYZ --reason "downstream PR just merged"
{
  "ok": true,
  "entry": {
    "schemaVersion": 1,
    "ts": "2026-05-02T15:21:48.103Z",
    "snapshotPath": "",
    "dispatcherTopId": "AISDLC-AAA",
    "operatorPickedId": "AISDLC-XYZ",
    "ranking": [
      { "id": "AISDLC-AAA", "position": 1 },
      { "id": "AISDLC-XYZ", "position": 4 }
    ],
    "reason": "downstream PR just merged",
    "mode": "composition"
  }
}
```

The CLI:

- Recomputes the current ranked frontier (composition mode, regardless
  of `AI_SDLC_DEPS_COMPOSITION` — the override IS the soak signal,
  even when the env flag isn't set yet).
- **Refuses** if `picked` is already the dispatcher's top pick (no
  override happened — would just pollute the corpus).
- **Refuses** if `picked` isn't on the ranked frontier at all
  (operator typo, or task isn't ready yet).
- Else appends one JSONL line to `$ARTIFACTS_DIR/_deps/overrides.jsonl`.

To list logged overrides for a quick eyeball without spawning the
aggregator:

```bash
$ cli-deps list-overrides --format table
Timestamp                       Dispatcher top  Operator picked  Reason
------------------------------  --------------  ---------------  -------------------
2026-05-02T15:21:48.103Z        AISDLC-AAA      AISDLC-XYZ       downstream PR ...
```

### Override log shape

Each override is one JSONL line under `$ARTIFACTS_DIR/_deps/overrides.jsonl`:

```jsonc
{
  "schemaVersion": 1,
  "ts": "2026-05-02T15:21:48.103Z",
  "snapshotPath": "",                        // optional join key against corpus
  "dispatcherTopId": "AISDLC-AAA",           // what composition picked
  "operatorPickedId": "AISDLC-XYZ",          // what the operator dispatched
  "ranking": [                               // capped at top 10 entries
    { "id": "AISDLC-AAA", "position": 1 },
    { "id": "AISDLC-XYZ", "position": 4 }
  ],
  "reason": "downstream PR just merged",     // optional free-text
  "mode": "composition"                       // 'composition' | 'baseline'
}
```

The schema is forward-versioned (`schemaVersion: 1`); future
revisions can add fields without breaking the aggregator's permissive
parser.

### Snapshot corpus aggregator — `cli-deps-corpus aggregate`

Sister CLI to `cli-dor-corpus` (AISDLC-161). Reads N downloaded
snapshot artifacts + the override log into a dispatch-quality envelope:

```bash
# Operator workflow (corpus path):
$ mkdir -p ./deps-corpus
$ cp -r ./artifacts/_deps/* ./deps-corpus/
$ cli-deps-corpus aggregate ./deps-corpus --format table
snapshot                     records  baseline-top   composition-top  agree
---------------------------  -------  -------------  ---------------  -----
2026-04-15T03-12-51.420Z     138      AISDLC-001     AISDLC-001       yes
2026-04-22T09-01-08.011Z     142      AISDLC-001     AISDLC-002       NO
2026-04-29T17-55-42.103Z     149      AISDLC-001     AISDLC-001       yes
...

Corpus: snapshots=50  files=50  skippedFiles=0  skippedLines=0
Dispatch agreement: 96.0%
Operator overrides: total=4  matchedToCorpus=3  rate=6.0%  distinctPickedIds=2
Recommendation: safe-to-promote
Reason: snapshotCount=50 ≥ 30, dispatchAgreementRate=96.0% ≥ 95.0%, override rate=6.0% < 10.0% — flip AI_SDLC_DEPS_COMPOSITION default OFF → ON
```

Tunables (defaults match RFC-0014 §11 Phase 5):

- `--min-snapshots` — corpus-size floor (default 30; below this,
  recommendation forces to `insufficient-data`)
- `--correctness-threshold` — dispatch-agreement floor (default 0.95)
- `--override-threshold` — operator override-rate ceiling (default 0.10)

The aggregator auto-detects an `overrides.jsonl` under the input root
(or pass `--overrides-file` for an explicit path).

### Recommendation envelope

Three values drive the operator decision per the runbook:

| `recommendation` | Meaning | Operator action |
|---|---|---|
| `safe-to-promote` | All gates green | Dispatch the flag-flip PR (corpus path) |
| `continue-soak` | Corpus has data but at least one gate failed; `reason` names it | Wait for more data, or tune the offending metric |
| `insufficient-data` | `snapshotCount < minSnapshots` | Wait for more activity, or use the override path in the runbook |

### Aggregator semantics — proxy caveat

Snapshot records carry `criticalPathLength`, `dependencies`, `id`, and
`lastModified` but **not** the per-task `priority:` field. The
aggregator's "composition top pick" is therefore a **proxy** that uses
only snapshot-resident structural signal (`criticalPathLength` DESC →
`lastModified` DESC → `id` ASC). This is conservative: the real
dispatcher's `effectivePriority` only ADDS a primary sort key, so a
real disagreement implies a proxy disagreement (and a proxy agreement
implies real-mode is also likely to agree). The override rate from
the live operator log is the math-rigorous ground-truth signal;
dispatch agreement is a secondary "is the proxy noisy?" check.

### Library API (Phase 5)

```ts
import {
  appendOverrideEntry,
  loadOverrides,
  type OverrideEntry,
} from '@ai-sdlc/pipeline-cli/deps';
import {
  aggregateDispatchCorpus,
  compareTopPicks,
  loadSnapshotCorpus,
  findSnapshotFiles,
} from '@ai-sdlc/pipeline-cli/deps-corpus';

// Operator override (e.g. from a slash command body):
const entry = appendOverrideEntry({
  snapshotPath: '/abs/path/snapshot.<iso>.dispatch.jsonl',
  dispatcherTopId: 'AISDLC-AAA',
  operatorPickedId: 'AISDLC-XYZ',
  ranking: [{ id: 'AISDLC-AAA', position: 1 }],
  reason: 'downstream PR just merged',
});

// Dashboard / soak A/B comparison:
const files = findSnapshotFiles('./deps-corpus');
const { snapshots, skippedFiles, skippedLines } = loadSnapshotCorpus(files);
const { entries: overrides } = loadOverrides({ artifactsDir: './deps-corpus' });
const report = aggregateDispatchCorpus(snapshots, { overrides });
console.log(report.aggregate.recommendation);
```

See `pipeline-cli/src/deps/override-log.ts` and
`pipeline-cli/src/cli/deps-corpus.ts` for the full type reference. The
runbook at [`docs/operations/deps-composition-promotion.md`](../../docs/operations/deps-composition-promotion.md)
walks operators through both promotion paths end-to-end.
