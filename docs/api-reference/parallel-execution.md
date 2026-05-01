# Parallel Execution

Programmatic surface for the parallel-execution and worktree-pooling subsystem
introduced by [RFC-0010 — Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md).

This page documents the runtime types integrators consume when authoring
pipelines that opt into pooled worktrees, per-stage harness routing,
subscription-aware scheduling, and per-worktree database isolation. The
operator-facing companion lives in [operator-runbook.md](../operations/operator-runbook.md);
the harness-author companion lives in [adapter-authoring.md](../operations/adapter-authoring.md).
This file is the API surface — what each interface looks like, which
fields are required, and how the orchestrator resolves them at
pipeline-load.

> **Status note.** RFC-0010 is Draft (v20). All interfaces below are
> normative once the RFC is signed off; today they are the contract the
> reference implementation in `orchestrator/` already targets. Field
> additions during the Draft → Approved transition will land here in
> sync with the RFC's revision history.

## HarnessAdapter

Every harness (Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider,
generic-API) implements the `HarnessAdapter` interface. Adapters are
registered at orchestrator startup and resolved per-stage by the
`Stage.harness` field. RFC-0010 §13.1 is the normative definition; this
section is the API surface integrators code against.

```typescript
interface HarnessAdapter {
  /** Stable identifier — must match the value used in Stage.harness. */
  readonly name: string;

  /** Capability matrix — see RFC-0010 §13.3 for the canonical table. */
  readonly capabilities: HarnessCapabilities;

  /** CLI binary requirement; checked at pipeline-load and at startup probe. */
  readonly requires: { binary: string; versionRange: string };

  /** Invoke the adapter for one stage execution. */
  run(ctx: HarnessContext): Promise<HarnessResult>;

  /**
   * Return a stable account identity for SubscriptionLedger keying.
   * Returning `undefined` degrades the ledger to per-pipeline scope and
   * emits a `LedgerKeyAmbiguous` warning (RFC-0010 §14.12).
   */
  getAccountId(): Promise<string | undefined>;
}
```

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Looked up from `Stage.harness`; pipeline-load fails on unknown. |
| `capabilities` | yes | Drives capability-aware fallback chains (RFC-0010 §13.3). |
| `requires.binary` | yes | Probed at startup; missing binary is a hard error before any pipeline runs. |
| `requires.versionRange` | yes | Open-ended (`>=X.Y.Z`) by default. Probe parsing failure emits `HarnessProbeFailed` warning but does not block validation. |
| `run` | yes | The actual stage invocation; orchestrator handles retry, fallback, and audit. |
| `getAccountId` | yes | When two pipelines on the same vendor account share quota, this is the key the SubscriptionLedger pools on (RFC-0010 v17). |

### Fallback chain

`Stage.harness` MAY be a single string or an ordered list. The orchestrator
tries each in order and falls over to the next on
`HarnessUnavailable` / `HarnessQuotaExhausted`. The actual harness used
for each stage is recorded in `$ARTIFACTS_DIR/<issue-id>/runtime.json` so
audit trails capture the real execution path.

### Independence guard

`Stage.requiresIndependentHarnessFrom: string[]` (RFC-0010 v13) lets
security-critical stages declare "I MUST NOT run on the same harness
that ran stage X." The orchestrator filters the harness chain to exclude
disqualified harnesses; if no candidate preserves independence it emits
`IndependenceViolated` and applies the stage's `onFailure` policy.

## WorktreePool

A `WorktreePool` is a declarative resource describing how many
git-worktree slots are available for parallel execution and how they are
allocated, reused, and reclaimed. RFC-0010 §6.2 is normative.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: WorktreePool
metadata:
  name: dogfood-pool
spec:
  maxConcurrent: 5
  branchTtl: 24h
  ownershipGuard: strict
  subscriptionPlans:
    - claude-code-max-20x
  databaseBranchPools:
    - primary-postgres
```

| Field | Required | Default | Purpose |
|---|---|---|---|
| `maxConcurrent` | no | derived from `SubscriptionPlan` (see below) | Cap on simultaneous worktrees. Hard upper bound regardless of incoming demand. |
| `branchTtl` | no | none | Age-out window for unreclaimed worktrees; the reclaimer drops worktrees older than this even when their parent PR has not merged. |
| `ownershipGuard` | no | `lenient` | When `strict`, worktrees that fail the cross-clone ownership check (RFC-0010 §7.4) are refused — protects against silent corruption when the same repo is cloned twice. |
| `subscriptionPlans` | no | `[]` | References to `SubscriptionPlan` resources by name. Drives the `maxConcurrent` default and the SubscriptionLedger keys. |
| `databaseBranchPools` | no | `[]` | References to `DatabaseBranchPool` resources; each provisions an isolated DB branch per allocated worktree. |

### `maxConcurrent` resolution

When `Pipeline.spec.parallelism.maxConcurrent` is omitted, it is derived
from the declared `SubscriptionPlan`:

| Declared plan | Default `maxConcurrent` |
|---|---|
| (none) | 1 — preserves today's serial behavior |
| `claude-code-pro` | 3 |
| `claude-code-max-5x` | 5 |
| `claude-code-max-20x` | 10 |

The resolution is computed once at pipeline-load and recorded in
`$ARTIFACTS_DIR/_pipeline/runtime.json`. Subscribing a SubscriptionPlan
after pipeline-load does NOT change the resolved cap until the pipeline
is reloaded.

### Lifecycle

1. **Allocate** — worktree manager reserves a slot, creates the worktree,
   records owner identity, attaches DB branches.
2. **Adopt** — when a stage resumes against an existing worktree, the
   manager validates ownership before re-attaching.
3. **Reclaim** — on PR merge or `branchTtl` expiration, the manager
   removes the worktree and releases attached resources (DB branches,
   ports, ledger reservations).

## DatabaseBranchAdapter

Per-worktree database isolation. Each adapter encapsulates one branching
mechanism (SQLite copy-per-worktree, Neon Postgres branching, generic
Postgres snapshot-restore, or operator-managed `external`). RFC-0010
§15.1 is normative.

```typescript
interface DatabaseBranchAdapter {
  readonly name: string;

  readonly capabilities: {
    branchCreationLatencyMs: number;   // typical p50
    maxBranches: number;               // hard upper bound
    supportsSchemaMigrations: boolean;
    supportsMultipleDatabases: boolean;
  };

  /** Provision a new branch from the upstream snapshot. */
  allocate(ctx: BranchAllocateContext): Promise<BranchHandle>;

  /** Release the branch and its underlying storage. */
  reclaim(handle: BranchHandle): Promise<void>;

  /**
   * Rewrite the connection string the application reads so it points at
   * the allocated branch rather than the upstream database.
   */
  rewriteConnectionString(handle: BranchHandle, original: string): string;
}
```

The `DatabaseBranchPool` resource references a registered adapter by
name, declares per-pool concurrency caps, and may opt into a warm pool:

| Field | Required | Default | Purpose |
|---|---|---|---|
| `adapter` | yes | — | Name of a registered DatabaseBranchAdapter; pipeline-load fails on unknown. |
| `lifecycle.maxConcurrent` | no | resolved `parallelism.maxConcurrent` | Cap on concurrent branches; MUST NOT exceed the adapter's `maxBranches`. |
| `lifecycle.warmPoolSize` | no | `0` | When `> 0`, orchestrator maintains pre-allocated branches; allocation hands one over in sub-100ms and asynchronously refills (RFC-0010 v19). |
| `allowBranchFromBranch` | no | `false` | Topology guard (RFC-0010 v20) — when `false`, all branches root from the stable upstream so reclamation never strands child branches. |

### Stage-side declaration

Stages opt into DB isolation via `Stage.databaseAccess`:

```yaml
stages:
  - name: implement
    agent: developer
    databaseAccess: read-write     # 'none' | 'read-only' | 'read-write'
```

`read-only` and `read-write` cause the orchestrator to allocate (or hand
over from the warm pool) a branch from each referenced
`DatabaseBranchPool` and inject the rewritten connection string via the
pool's `injection.targetEnv` (e.g. `DATABASE_URL`,
`ANALYTICS_DATABASE_URL`).

## SubscriptionPlan and SubscriptionLedger

The `SubscriptionPlan` resource declares a billing window — token
allocation, off-peak multiplier, freshness signal. RFC-0010 §6.6 is
normative.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: SubscriptionPlan
metadata:
  name: claude-code-max-20x
spec:
  harness: claude-code
  billingMode: session-window
  windowDuration: 5h
  windowQuotaTokens: 8000000
  offPeak:
    schedule: '...'                 # operator-declared, vendor-specific
    multiplier: 2
    lastVerified: '2026-04-26'
  quotaSource: self-tracked         # 'self-tracked' | 'authoritative-api'
                                    # | 'authoritative-with-fallback'
  accountId: null                   # MAY override HarnessAdapter.getAccountId()
```

| Field | Required | Purpose |
|---|---|---|
| `harness` | yes | Plan applies to this harness only. |
| `billingMode` | yes | `session-window` (rolling quotas), `monthly-cap` (Codex Plus/Pro), `pay-per-token` (no quota — preserves today's behavior). |
| `windowQuotaTokens` | yes for `session-window` / `monthly-cap` | Token allocation per window, multiplier-adjusted at off-peak times. |
| `offPeak.schedule` | no | Operator-declared off-peak hours; orchestrator MUST NOT infer from any other source. |
| `offPeak.multiplier` | no | Token allocation multiplier during off-peak. Claude Code Max is ~2× at the time of writing — verify against vendor docs. |
| `offPeak.lastVerified` | no | ISO 8601 date of last operator verification. Missing or > 30 days old emits `OffPeakScheduleStale` warning. |
| `quotaSource` | no | `self-tracked` (default) ledger from observed usage; `authoritative-api` / `authoritative-with-fallback` consult the vendor's quota-introspection API once available. |
| `accountId` | no | Override for the auto-derived `HarnessAdapter.getAccountId()` value when the harness can't expose a stable identity. |

### SubscriptionLedger

The runtime ledger surface:

```typescript
interface SubscriptionLedger {
  /** Window state for one (harness, accountId, tenant) tuple. */
  windowState(key: LedgerKey): WindowState;

  /** Reserve N tokens against the current window; throws QuotaExhausted on overflow. */
  reserve(key: LedgerKey, tokens: number): Reservation;

  /** Release a reservation that was not fully consumed. */
  release(reservation: Reservation, unusedTokens: number): void;

  /** Append-only audit record for tier-analysis aggregation. */
  record(event: LedgerEvent): void;
}
```

Ledger keys are `(harness, accountId, tenant)` tuples (RFC-0010 v17), so
two pipelines on the same vendor account auto-pool quota and two
pipelines on different accounts auto-isolate. `Pipeline.spec.tenant` +
`tenantQuotaShare` carve a single account into virtual sub-windows for
internal cost allocation.

## Stage extensions

RFC-0010 amends the `Stage` object (RFC-0002 §3) with the following
fields. All are optional unless noted; absence preserves today's
behavior.

| Field | Type | Default | Reference |
|---|---|---|---|
| `model` | string | inherited from agent role | RFC-0010 §11 — per-stage model routing |
| `harness` | string &#124; string[] | `claude-code` | RFC-0010 §13 — per-stage harness selection; list form is the fallback chain |
| `databaseAccess` | `'none'` &#124; `'read-only'` &#124; `'read-write'` | `none` | RFC-0010 §15 — per-stage DB isolation declaration |
| `requiresIndependentHarnessFrom` | string[] | `[]` | RFC-0010 v13 — independence guard for security-critical stages |
| `estimatedTokens` | `{ input: number; output: number }` | `{ 50000, 10000 }` (with warning) | RFC-0010 v16 — drives admission control + scheduling |
| `schedule` | `'any'` &#124; `'prefer-off-peak'` &#124; `'require-current-window'` &#124; `'off-peak-only'` | `any` | RFC-0010 §14 — subscription-aware scheduling hints |

### `estimatedTokens` cold-start

Missing `estimatedTokens` falls through to a default of
`{ input: 50000, output: 10000 }` and emits a `MissingEstimate` warning.
After first execution, a rolling estimate replaces the default and
`EstimateBootstrapped` is emitted once recording the divergence.
Operators MAY freeze the empirical value back to the pipeline YAML to
opt out of the rolling update.

## DeterministicPortAllocator

Parallel agents need stable, collision-resistant local ports. RFC-0010
§8 defines a deterministic hash from `(issueId, role)` to a port in the
range `[10000, 10900]`. The function's range bounds expected collisions:
with `maxConcurrent: 10` the birthday-paradox collision probability is
< 6%. On collision, the orchestrator probes the next ten consecutive
ports for a free one and records the actual port in
`$ARTIFACTS_DIR/<issue-id>/runtime.json`.

```typescript
interface PortAllocator {
  /** Returns the deterministic candidate port for (issueId, role). */
  candidate(issueId: string, role: string): number;

  /** Returns the actually-bound port (deterministic candidate or first free probe). */
  allocate(issueId: string, role: string): Promise<number>;
}
```

## Artifact directory convention

Every parallel run writes artifacts under
`$ARTIFACTS_DIR/<issue-id>/` (per-issue) and
`$ARTIFACTS_DIR/_pipeline/` and `$ARTIFACTS_DIR/_ledger/` (pipeline-wide).
Stage outputs are emitted as paired files: a human-narrative `.md`
operator-friendly file AND a schema-conformant `.json`
machine-readable file (RFC-0010 v12). Adapters MUST validate the JSON
against the relevant schema in `spec/schemas/artifacts/`; schema
validation failure is a stage failure (`ArtifactSchemaInvalid`).

## See also

- [RFC-0010 — Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) — full normative spec
- [Operator runbook](../operations/operator-runbook.md) — operator workflow that consumes these interfaces
- [Adapter authoring guide](../operations/adapter-authoring.md) — how to author a new HarnessAdapter or DatabaseBranchAdapter
- [Runners](runners.md) — the legacy single-agent runner abstraction RFC-0010 generalizes from
