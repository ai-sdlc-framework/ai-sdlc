# Parallel Execution

Programmatic surface for the parallel-execution and worktree-pooling subsystem
introduced by [RFC-0010 — Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md).

This page is the **RFC-0010 surface companion**: it tracks the RFC literally.
Every interface signature, field table, enum, default, and example YAML on this
page MUST match the RFC's normative sections (§6, §8, §9.1, §11, §13, §14, §15,
§16). Any divergence is a doc bug — file a follow-up to bring the doc back in
line with the RFC, do not edit the RFC to match the doc. The operator-facing
companion lives in [operator-runbook.md](../operations/operator-runbook.md);
the harness-author companion lives in [adapter-authoring.md](../operations/adapter-authoring.md).

> **Status note.** RFC-0010 is Draft (v20). All interfaces below are normative
> once the RFC is signed off; today they are the contract the reference
> implementation in `orchestrator/` already targets.
>
> **How this doc is maintained.** When the RFC's revision history advances
> (a new `vN` row that touches schema, interface, or enum), the corresponding
> sections of this page MUST be updated in the same PR (or a fast-follow PR
> referenced in the RFC commit body). The `pnpm rfc:check` gate enforces the
> presence of `requiresDocs: [api-reference]` in the RFC frontmatter so the
> coupling is visible at PR time.

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

  /** CLI binary requirement; checked at pipeline-load via the version probe. */
  readonly requires: HarnessRequires;

  /** Validate at pipeline-load time, before any execution. */
  validate(stage: ResolvedStage): ValidationResult;

  /**
   * Execute one stage end-to-end. Streams progress via onEvent so the
   * orchestrator can update heartbeats and burn-down telemetry mid-run.
   */
  invoke(input: HarnessInput, onEvent: (e: HarnessEvent) => void): Promise<HarnessResult>;

  /** List models the harness can drive (after env-var introspection). */
  availableModels(): Promise<string[]>;

  /**
   * Cheap liveness probe used by the fallback chain. Combines binary presence,
   * version-range check, and adapter-specific health probe. Result MAY be
   * cached for the orchestrator's lifetime; operator restart picks up a
   * freshly-installed binary.
   */
  isAvailable(): Promise<HarnessAvailability>;

  /**
   * Stable identifier for the credential / account in scope. Used as the
   * SubscriptionLedger key so two pipelines on the same vendor account
   * auto-pool. MUST be a one-way derivation (e.g., SHA-256 of the API key
   * + harness name) and MUST NOT leak the credential itself. Returns null
   * when the harness cannot derive an account identity (e.g., generic-api
   * with no auth scheme), in which case the orchestrator emits
   * LedgerKeyAmbiguous and degrades to per-pipeline ledger keying
   * (RFC-0010 §14.12).
   */
  getAccountId(): Promise<string | null>;
}
```

| Method / field | Required | Purpose |
|---|---|---|
| `name` | yes | Looked up from `Stage.harness`; pipeline-load fails on unknown. |
| `capabilities` | yes | Drives capability-aware fallback chains (RFC-0010 §13.3). |
| `requires.binary` | yes | Probed at startup; missing binary fails the primary at pipeline-load and removes the fallback with a warning. |
| `requires.versionRange` | yes | Open-ended (`>=X.Y.Z`) by default. Probe parsing failure emits `HarnessProbeFailed` warning but does not block validation. |
| `validate()` | yes | Pipeline-load gate; called once per stage that targets this adapter. |
| `invoke()` | yes | The actual stage invocation. Orchestrator handles retry, fallback, and audit around it. |
| `availableModels()` | yes | Called during validation to confirm `Stage.model` resolves against this harness. |
| `isAvailable()` | yes | Liveness probe consulted by the fallback chain at dispatch time AND at pipeline-load (§13.4). |
| `getAccountId()` | yes | When two pipelines on the same vendor account share quota, this is the key the SubscriptionLedger pools on (RFC-0010 §14.12). Returning `null` triggers `LedgerKeyAmbiguous` and per-pipeline ledger keying. |

### Fallback chain

`Stage.harness` is a single string naming the primary harness. Ordered
fallback preference is declared separately on `Stage.harnessFallback`
(`array[string]`, §6.3). The orchestrator probes `primary.isAvailable()`,
attempts `invoke()`, and on `result.status === 'unavailable'` or rate-limit
error proceeds through `harnessFallback` in order. The actual harness used
for each stage is recorded in `$ARTIFACTS_DIR/<issue-id>/runtime.json` so
audit trails capture the real execution path. Fallback MUST NOT trigger on
stage *content* failures — only on availability failures the adapter maps
into the `HarnessResult.status` taxonomy.

### Independence guard

`Stage.requiresIndependentHarnessFrom: string[]` (RFC-0010 §13.10) lets
security-critical stages declare "I MUST NOT run on the same harness that
ran stage X." At dispatch time the orchestrator reads each named upstream
stage's `runtime.json`, builds a forbidden set from the harnesses that
actually ran (which MAY differ from the declared `harness` if a fallback was
used), and filters the candidate chain (`[harness, ...harnessFallback]`) to
exclude them. If no candidate preserves independence the orchestrator emits
`IndependenceViolated` and applies the stage's `onFailure` policy
(`continue` advisory by default; security-critical pipelines SHOULD set
`abort`). Cyclic constraints fail pipeline-load with
`CyclicIndependenceConstraint`.

## WorktreePool

A `WorktreePool` is a declarative resource describing where worktrees live
on disk, how stale ones are reclaimed, and which subscription / database
pools attach to them. RFC-0010 §6.2 is normative.

```yaml
apiVersion: ai-sdlc.dev/v1alpha1
kind: WorktreePool
metadata:
  name: default-pool
spec:
  rootDir: ~/.ai-sdlc/worktrees
  layout: workspace-scoped       # or "repo-local"
  staleThresholdDays: 14
  basePort: 3190
  ownershipGuard: strict         # "strict" | "advisory"
  cleanup:
    onMerge: true
    onAbort: true
    onTimeout: true
  databaseBranchPools:           # optional, references DatabaseBranchPool resources by name (§6.7)
    - primary-postgres
    - analytics-postgres
  subscriptionPlans:             # optional, references SubscriptionPlan resources by name (§6.6)
    - claude-code-max-5x
```

| Field | Required | Default | Purpose |
|---|---|---|---|
| `rootDir` | no | `~/.ai-sdlc/worktrees` | Filesystem root for allocated worktrees. |
| `layout` | no | `workspace-scoped` | One of `workspace-scoped` (single root for all repos) or `repo-local` (worktrees co-located with each repo). |
| `staleThresholdDays` | no | `14` | Age-out window for unreclaimed worktrees; the reclaimer drops worktrees older than this when no active pipeline run references them. |
| `basePort` | no | `3190` | Lower bound for the deterministic port allocator (§8). Effective range is `[basePort + 100, basePort + 999]`. |
| `ownershipGuard` | no | `strict` | One of `strict` or `advisory`. When `strict`, worktrees that fail the cross-clone ownership check (§7.2) are refused — protects against silent corruption when the same repo is cloned twice. |
| `cleanup.onMerge` | no | `true` | Reclaim worktree when its PR merges. |
| `cleanup.onAbort` | no | `true` | Reclaim worktree when its pipeline run aborts. |
| `cleanup.onTimeout` | no | `true` | Reclaim worktree when its allocation exceeds the configured timeout. |
| `databaseBranchPools` | no | `[]` | References to `DatabaseBranchPool` resources by name; each provisions an isolated DB branch per allocated worktree (§6.7). |
| `subscriptionPlans` | no | `[]` | References to `SubscriptionPlan` resources by name (§6.6). Drives the `parallelism.maxConcurrent` default and the SubscriptionLedger keys. |

### Pipeline parallelism

`maxConcurrent` is NOT a `WorktreePool` field. It lives on
`Pipeline.spec.parallelism.maxConcurrent` (RFC-0010 §6.1):

| Field | Type | Required | Description |
|---|---|---|---|
| `parallelism` | object | MAY | Concurrency configuration. When omitted, pipelines execute serially (current behavior). |
| `parallelism.maxConcurrent` | integer | MAY | Maximum number of issues executing concurrently. Range: 1–20. When omitted, derived from the declared SubscriptionPlan per the resolution table below. |
| `parallelism.worktreePool` | string | MAY | Reference to a `WorktreePool` resource by name. Defaults to the pipeline's name. |
| `parallelism.mergeStrategy` | string | MAY | One of `serialized-rebase` (default) or `parallel-merge` (forbidden in v1, reserved). |

When `Pipeline.spec.parallelism.maxConcurrent` is omitted, the orchestrator
resolves it in this order (RFC-0010 §9.1):

1. Explicit `Pipeline.spec.parallelism.maxConcurrent` (if present).
2. Tier-aware default derived from any `SubscriptionPlan` referenced by the pipeline's harness:

| Declared SubscriptionPlan | Default `maxConcurrent` | Rationale |
|---|---|---|
| (none declared) | `1` | Backward-compatible with today's serial behavior; no surprise regressions on plugin upgrade. |
| `claude-code-pro` | `3` | Pro tier quota sustains ~3 concurrent Opus stages over a 5h window without exhausting hardCap. |
| `claude-code-max-5x` | `5` | 5× quota → 5 concurrent stages without burndown alarm. |
| `claude-code-max-20x` | `10` | 20× quota leaves headroom for the 10-cap ceiling we set in §6.1. |
| `codex-plus` | `2` | Lower monthly cap; conservative default. |
| `codex-pro` | `5` | Comparable to Max-5x. |
| `pay-per-token` | `5` | No quota constraint; cap chosen for host-resource sanity. |
| Multiple plans for the same harness | `sum(per-plan default)` | Operator with multiple seats gets additive headroom. |
| Multiple harnesses across stages | `max(per-harness default)` | Dispatcher caps total in-flight; per-harness contention surfaces via `QuotaContention`. |

3. Hard floor `1`, hard ceiling `20`. Resolved value is clamped to this range and logged as `ResolvedParallelism` at pipeline-load time.

The resolution is computed once at pipeline-load and recorded in
`$ARTIFACTS_DIR/_pipeline/runtime.json`. Subscribing a SubscriptionPlan
after pipeline-load does NOT change the resolved cap until the pipeline
is reloaded — operators MUST restart the pipeline run to pick up a new
tier.

### Lifecycle

1. **Allocate** — worktree manager reserves a slot, creates the worktree
   (`git worktree add <pool>/<branch-slug> -b <branch> origin/<targetBranch>`),
   records owner identity, and attaches DB branches per the referenced
   `DatabaseBranchPool` resources.
2. **Adopt** — when a stage resumes against an existing worktree (matching
   branch name), `verifyOwnership(worktreePath, currentRepoPath)` validates
   the `.git` pointer resolves under the current repo's
   `.git/worktrees/`. Failure refuses with `WorktreeOwnershipMismatch`
   when `ownershipGuard: strict`.
3. **Reclaim** — on PR merge, abort, timeout, or `staleThresholdDays`
   expiration, the manager removes the worktree and releases attached
   resources (DB branches, ports, ledger reservations). Reclamation MUST
   refuse a worktree with uncommitted changes without operator confirmation.

## DatabaseBranchAdapter

Per-worktree database isolation. Each adapter encapsulates one branching
mechanism (SQLite copy-per-worktree, Neon Postgres branching, generic
Postgres snapshot-restore, or operator-managed `external`). RFC-0010
§15.1 is normative.

```typescript
interface DatabaseBranchAdapter {
  readonly name: string;                       // 'neon', 'sqlite-copy', etc.
  readonly capabilities: DatabaseBranchCapabilities;

  /**
   * Validate at pipeline-load: credentials present, upstream reachable,
   * no obvious misconfiguration.
   */
  validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult>;

  /** Provision a new branch from the pool's upstream. */
  allocate(pool: ResolvedDatabaseBranchPool, branchKey: string): Promise<DatabaseBranchHandle>;

  /** Destroy a branch and free its quota slot. */
  reclaim(handle: DatabaseBranchHandle): Promise<void>;

  /**
   * List currently active branches in the upstream account, scoped to this
   * pool. Used for stale-branch sweep on orchestrator startup.
   */
  list(pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]>;

  /** Liveness probe. */
  isAvailable(pool: ResolvedDatabaseBranchPool): Promise<boolean>;
}

interface DatabaseBranchCapabilities {
  branchCreationLatencyP50Ms: number;     // 'fast' < 5000, 'slow' >= 60000
  maxBranches: number;                    // adapter or vendor cap
  supportsMigrations: boolean;            // can adapter run migrations during allocate
  supportsReadOnlyBranches: boolean;      // can multiple worktrees share a read branch
  supportsBranchFromBranch: boolean;      // can branch from another branch (Neon: yes)
  multiDatabase: boolean;                 // can pool serve more than one DB per branch
  costModel: 'per-branch-storage' | 'per-snapshot' | 'free';
}

interface DatabaseBranchHandle {
  branchKey: string;                      // stable key, derived from worktree branch name
  connectionString: string;               // URL the agent will use (NEVER logged in cleartext)
  createdAt: Date;
  upstream: string;                       // upstream branch this was derived from
  upstreamCommitId?: string;              // adapter-specific snapshot identifier
  metadata: Record<string, string>;       // adapter-specific (Neon: branch_id, project_id)
}
```

Connection-string rewriting is the orchestrator's concern, not the
adapter's: at stage dispatch the orchestrator overlays `injection.targetEnv`
(and any `injection.additionalEnvs`) with values derived from
`DatabaseBranchHandle.connectionString` (RFC-0010 §15.6). Adapters MUST
NOT log the connection string and MUST mask it in any error they raise.

### DatabaseBranchPool

```yaml
apiVersion: ai-sdlc.dev/v1alpha1
kind: DatabaseBranchPool
metadata:
  name: primary-postgres
spec:
  adapter: neon                            # 'neon' | 'sqlite-copy' | 'pg-snapshot-restore' | 'supabase' | 'external'
  upstream:
    connectionStringEnv: DATABASE_URL_DEV
    branchFrom: dev
  injection:
    targetEnv: DATABASE_URL
    additionalEnvs: [PGHOST, PGDATABASE]
  lifecycle:
    createOn: worktree-allocation          # 'worktree-allocation' | 'first-write-stage'
    reclaimOn: pr-merge                    # 'pr-merge' | 'worktree-reclaim' | 'manual'
    maxConcurrent: 10
    branchTtl: P14D
    abandonAfter: P7D
    warmPoolSize: 0
  migrations:
    runOnBranchCreate: true
    migrationCommand: 'pnpm db:migrate'
    migrationCwd: orchestrator
  credentials:
    apiTokenEnv: NEON_API_TOKEN
    projectId: prj_abc123
```

| Field | Required | Default | Purpose |
|---|---|---|---|
| `adapter` | yes | — | Name of a registered DatabaseBranchAdapter; pipeline-load fails on unknown. |
| `upstream` | yes | — | Source database to branch from. |
| `upstream.connectionStringEnv` | yes | — | Env var name the orchestrator reads at startup to discover upstream. The connection string itself is NEVER logged or persisted. |
| `upstream.branchFrom` | adapter-dependent | — | Named upstream branch (Neon, Supabase) or upstream identifier for snapshot-restore. By default MUST reference a stable, non-PR-feature upstream (e.g., `dev`, `main`). |
| `allowBranchFromBranch` | no | `false` | When `false`, the adapter MUST refuse to allocate a branch whose upstream is itself an in-flight feature branch — pipeline-load fails with `BranchTopologyForbidden`. When `true`, operator opts into branch-from-branch chains and accepts `MigrationDiverged` events on parent reclaim (§15.5.1). |
| `injection` | yes | — | How the branch's connection string is exposed to agents. |
| `injection.targetEnv` | yes | — | Env var name rewritten in the agent's environment. |
| `injection.additionalEnvs` | no | `[]` | Additional env vars to derive (host, port, database, user) from the rewritten connection string. |
| `lifecycle.createOn` | no | `worktree-allocation` | When to provision the branch. `worktree-allocation` creates eagerly; `first-write-stage` creates lazily and is cheaper if many runs only have read stages. |
| `lifecycle.reclaimOn` | no | `pr-merge` | When to destroy the branch. |
| `lifecycle.maxConcurrent` | no | resolved `Pipeline.spec.parallelism.maxConcurrent` | Cap on concurrent branches; MUST NOT exceed the adapter's `maxBranches` capability. |
| `lifecycle.branchTtl` | no | none | ISO 8601 max branch age. Branches older than TTL are reclaimed regardless of activity. |
| `lifecycle.abandonAfter` | no | `P7D` | ISO 8601 idle threshold. Destroy if no activity, even before TTL. |
| `lifecycle.warmPoolSize` | no | `0` | Pre-allocated branch count (0–20). When > 0, orchestrator maintains pre-allocated branches; allocation hands one over in sub-100ms and asynchronously refills (§15.4.1). |
| `migrations.runOnBranchCreate` | no | `true` | Run pending migrations against the branch immediately on creation. |
| `migrations.migrationCommand` | when `runOnBranchCreate: true` | — | Shell command executed inside the worktree, with the branch's connection string injected. |
| `migrations.migrationCwd` | no | worktree root | Subdirectory relative to worktree root. |
| `credentials` | adapter-dependent | — | Adapter-specific configuration (see §15.3 for per-adapter shapes). |

### Stage-side declaration

Stages opt into DB isolation via `Stage.databaseAccess` (RFC-0010 §6.3,
§15.7):

```yaml
stages:
  - name: implement
    agent: developer
    databaseAccess: write              # 'none' | 'read' | 'write' | 'migrate'
```

| Value | Behavior |
|---|---|
| `none` | No branch provisioned. Env vars not injected. Cheapest. Default. |
| `read` | If the adapter `supportsReadOnlyBranches`, a single shared read-only branch MAY serve multiple worktrees. Connection string injected. |
| `write` | A per-worktree writable branch is required. Branch is provisioned eagerly or lazily per `lifecycle.createOn`. |
| `migrate` | Same as `write`, plus the orchestrator MUST acquire the merge gate (§10) before stage execution to serialize schema changes against the upstream HEAD. |

`read`, `write`, and `migrate` cause the orchestrator to allocate (or hand
over from the warm pool) a branch from each referenced
`DatabaseBranchPool` and inject the rewritten connection string via the
pool's `injection.targetEnv` (e.g., `DATABASE_URL`,
`ANALYTICS_DATABASE_URL`).

## SubscriptionPlan and SubscriptionLedger

The `SubscriptionPlan` resource declares a billing window — token
allocation, off-peak multiplier, freshness signal. RFC-0010 §6.6 is
normative.

```yaml
apiVersion: ai-sdlc.dev/v1alpha1
kind: SubscriptionPlan
metadata:
  name: claude-code-max-5x
spec:
  harness: claude-code
  billingMode: session-window           # "session-window" | "monthly-cap" | "pay-per-token"
  windowDuration: PT5H                  # ISO 8601, only for session-window
  windowQuotaTokens: 1000000            # documented per-window cap
  offPeak:
    enabled: true
    multiplier: 2.0                     # 2× tokens during off-peak
    schedule:
      - { tz: 'America/Los_Angeles', hours: '22-06' }
      - { tz: 'America/Los_Angeles', hours: '0-7', daysOfWeek: 'Sat,Sun' }
    lastVerified: '2026-04-15'          # operator confirmed against vendor docs on this date
  pacingTarget: 0.85                    # aim to consume 85% of window before reset
  hardCap: 0.95                         # MUST NOT dispatch new work above this fraction
  quotaSource: self-tracked             # 'self-tracked' (default) | 'authoritative-api' | 'authoritative-with-fallback'
```

| Field | Required | Purpose |
|---|---|---|
| `harness` | yes | Name of the registered harness this plan applies to. |
| `billingMode` | yes | One of `session-window` (rolling quotas), `monthly-cap` (Codex Plus/Pro), `pay-per-token` (no quota — preserves today's behavior). |
| `windowDuration` | when `session-window` | ISO 8601 duration of the rolling window. |
| `windowQuotaTokens` | when `session-window` or `monthly-cap` | Documented quota per window, multiplier-adjusted at off-peak times. |
| `offPeak` | no | Multiplier configuration. Absent → no off-peak preference. |
| `offPeak.schedule` | no | Operator-declared off-peak hours; orchestrator MUST NOT infer from any other source. |
| `offPeak.multiplier` | no | Token allocation multiplier during off-peak. Claude Code Max is ~2× at the time of writing — verify against vendor docs. |
| `offPeak.lastVerified` | no | ISO 8601 date of last operator verification. Missing or > 30 days old emits `OffPeakScheduleStale` warning; > 90 days escalates the warning to ERROR. |
| `pacingTarget` | no | Burn-down target [0,1]. Defaults to `0.80`. |
| `hardCap` | no | Above this fraction of window quota, the orchestrator MUST NOT dispatch new work even if a stage has `schedule: now`. Defaults to `0.95`. |
| `quotaSource` | no | `self-tracked` (default), `authoritative-api`, or `authoritative-with-fallback`. See §14.11 for migration semantics. |

`SubscriptionPlan` is referenced by `WorktreePool.spec.subscriptionPlans[]`
(or pipeline-scoped). Multiple plans MAY exist per harness when an account
has multiple seats; the orchestrator distributes work across them.

### Account / tenant overrides

The pipeline MAY override account derivation and partition a shared
account into virtual sub-windows for internal cost allocation
(RFC-0010 §6.5, §14.12):

| Field | Type | Purpose |
|---|---|---|
| `Pipeline.spec.accountId` | string | Override for the auto-derived account identity from `HarnessAdapter.getAccountId()`. Useful when the harness can't expose a stable identity. |
| `Pipeline.spec.tenant` | string | Tenant identifier for SubscriptionLedger keying. When set, partitions a shared vendor account into virtual sub-windows. When omitted, all pipelines on the same `(harness, accountId)` share a single ledger. |
| `Pipeline.spec.tenantQuotaShare` | number [0,1] | Fraction of the shared account's `windowQuotaTokens` allocated to this tenant. Required when `tenant` is set AND multiple tenants exist on the same `(harness, accountId)`. Sum of shares across all tenants on the same account MUST equal 1.0; validated at orchestrator startup. |

### SubscriptionLedger

The runtime ledger surface (RFC-0010 §14.2):

```typescript
interface SubscriptionLedger {
  /** Current state for a harness, summed across all SubscriptionPlans. */
  windowState(harness: string): WindowState;

  /**
   * Can a stage with these estimated tokens be dispatched now without
   * exceeding the hardCap? Returns 'yes' | 'wait-until-T' | 'no'.
   */
  admit(harness: string, estimatedTokens: TokenEstimate): AdmissionDecision;

  /**
   * Record observed consumption from a completed stage invocation.
   * Updates rolling estimates and pacing projections.
   */
  record(harness: string, actual: TokenUsage, when: Date): void;

  /** Is now within an off-peak window for this harness? */
  isOffPeak(harness: string, when?: Date): boolean;

  /** When does the next off-peak window start, if any? */
  nextOffPeakStart(harness: string): Date | null;

  /** Projected utilization at window-end given current pace + queued work. */
  projectedUtilization(harness: string): number;  // [0, ∞)
}

interface WindowState {
  windowStart: Date;
  windowEnd: Date;
  consumedTokens: number;
  quotaTokens: number;
  multiplier: number;          // 1.0 on-peak, 2.0 off-peak (Claude Code)
  utilizationFraction: number; // consumed / quota
  pacingTarget: number;
  hardCap: number;
}
```

Ledger keys are `(harness, accountId, tenant)` tuples (RFC-0010 §14.12), so
two pipelines on the same vendor account auto-pool quota and two pipelines
on different accounts auto-isolate. The ledger persists state at
`$ARTIFACTS_DIR/_ledger/<harness>-<accountIdShort>-<tenant>.json` (one file
per ledger key) so it survives orchestrator restarts within a window.
`Pipeline.spec.tenant` + `tenantQuotaShare` carve a single account into
virtual sub-windows for internal cost allocation.

## Stage extensions

RFC-0010 amends the `Stage` object (RFC-0002 §3) with the following
fields. All are optional unless noted; absence preserves today's
behavior. RFC-0010 §6.3 is normative.

| Field | Type | Default | Reference |
|---|---|---|---|
| `isolation` | `'worktree'` &#124; `'inplace'` | `worktree` (when `parallelism` is set) | RFC-0010 §6.3 — stages that must operate on the main checkout (e.g., release tagging) MUST set `inplace`. |
| `holdsMergeGate` | boolean | `false` | RFC-0010 §6.3, §10 — when `true`, stage acquires the pipeline's merge gate for the duration of its execution. The final merge stage MUST set this to `true`. |
| `model` | `'haiku'` &#124; `'sonnet'` &#124; `'opus'` &#124; `'opus[1m]'` &#124; `'inherit'` &#124; `<explicit model ID>` | `inherit` | RFC-0010 §6.3, §11 — per-stage model routing. |
| `kind` | `'agent'` &#124; `'review-classifier'` &#124; `'review-fanout'` | `agent` | RFC-0010 §6.3, §12 — drives stage-specific execution semantics. |
| `maxBudgetUsd` | number | none | RFC-0010 §6.3, §11.5 — per-stage cost ceiling. When exceeded, orchestrator emits `BudgetExceeded` and applies `onFailure`. Hooks into RFC-0004 cost attribution. |
| `harness` | `'claude-code'` &#124; `'codex'` &#124; `'gemini-cli'` &#124; `'opencode'` &#124; `'aider'` &#124; `'generic-api'` &#124; `'inherit'` | `claude-code` (or `Pipeline.spec.defaultHarness`) | RFC-0010 §6.3, §13 — per-stage harness selection. Single string; pipeline-load FAILS on unregistered harness. |
| `harnessFallback` | `array[string]` | `[]` (or `Pipeline.spec.defaultHarnessFallback`) | RFC-0010 §6.3, §13.5 — ordered preference list. If the primary is unavailable (rate-limited, capability mismatch, runtime error), the orchestrator MUST attempt each fallback in order before applying `onFailure`. |
| `requiresIndependentHarnessFrom` | `array[string]` | `[]` | RFC-0010 §6.3, §13.10 — independence guard for security-critical stages. |
| `schedule` | `'now'` &#124; `'off-peak'` &#124; `'quota-permitting'` &#124; `'defer-if-low-priority'` | `now` | RFC-0010 §6.3, §14.3 — subscription-aware scheduling hints. |
| `estimatedTokens` | `{ input: number, output: number, frozen?: boolean }` | `{ input: 50000, output: 10000 }` (with `MissingEstimate` warning) | RFC-0010 §6.3, §14.6 — operator hint used by the SubscriptionLedger for window-headroom calculations. |
| `databaseAccess` | `'none'` &#124; `'read'` &#124; `'write'` &#124; `'migrate'` | `none` | RFC-0010 §6.3, §15 — per-stage DB isolation declaration. `read` MAY share a single read-only branch across worktrees; `write` and `migrate` REQUIRE a per-worktree writable branch; `migrate` additionally takes the merge gate per §15.7. |

### `model` resolution chain

At pipeline-load (NOT stage entry), the orchestrator resolves every stage's
alias to a physical model ID in this order (RFC-0010 §11.1):

1. Explicit `Stage.model` (if not `inherit`).
2. `Pipeline.spec.defaultModel` (RFC-0010 §6.4).
3. The orchestrator's hardcoded default (`sonnet`).

`Pipeline.spec.defaultModel` is the new optional pipeline-scoped field
introduced in §6.4 and defaults to `sonnet`. The same value space as
`Stage.model` applies. Resolved physical IDs are pinned to
`$ARTIFACTS_DIR/_pipeline/runtime.json` for the lifetime of the run; mid-stage
model changes are NOT supported.

| Alias | Resolves to (current) | Use case |
|---|---|---|
| `haiku` | `claude-haiku-4-5-20251001` | Classification, routing, formatting, structured-output extraction |
| `sonnet` | `claude-sonnet-4-6` | Code review, refactoring, validation, default for everything else |
| `opus` | `claude-opus-4-7` | Complex implementation, multi-file refactors, design work |
| `opus[1m]` | `claude-opus-4-7[1m]` | Implementation against a large codebase context (>200K tokens) |

The registry (`orchestrator/src/models/registry.ts`) tracks each entry's
`deprecatedAt: Date | null` and `removedAt: Date | null`. Pipeline-load
emits `ModelDeprecated` for deprecated models (with replacement alias) and
FAILS with `ModelRemoved` for removed ones (RFC-0010 §11.6).

### `harness` resolution

`Pipeline.spec.defaultHarness` (default `claude-code`) and
`Pipeline.spec.defaultHarnessFallback` mirror the model-resolution chain
for harness selection (RFC-0010 §6.5). Stages with `harness: inherit`
resolve to `defaultHarness`; stages omitting `harnessFallback` inherit
`defaultHarnessFallback`.

### `estimatedTokens` cold-start

Missing `estimatedTokens` falls through to the cold-start default
`{ input: 50000, output: 10000 }` and emits a `MissingEstimate` warning at
pipeline-load. After first execution, a rolling estimate (last 20
invocations, exponentially weighted) at
`$ARTIFACTS_DIR/_ledger/stage-estimates.json` replaces the default and the
orchestrator emits a one-time `EstimateBootstrapped` event recording the
divergence. Operators MAY freeze the empirical value back to the pipeline
YAML (`frozen: true`) to opt out of the rolling update — useful for stages
with bimodal consumption where the rolling mean is materially wrong
(RFC-0010 §14.6).

## DeterministicPortAllocator

Parallel agents need stable, collision-resistant local ports. RFC-0010 §8
defines a deterministic hash from the worktree's absolute path to a port:

```
port(worktreePath, basePort = 3190):
  digest = md5(absolute(worktreePath))
  offset = (digest[0] << 8 | digest[1]) % 900 + 100
  return basePort + offset
```

This produces ports in `[basePort + 100, basePort + 999]` (default
`3290–4189`). Same worktree path → same port, with no central coordinator.
With the default `WorktreePool.spec` cap of `maxConcurrent: 10`, the
birthday-paradox collision probability is < 6%. On collision the
orchestrator MUST log a `PortCollision` warning and probe the next ten
consecutive ports for a free one. The probed port is recorded in
`$ARTIFACTS_DIR/<issue-id>/runtime.json` so subsequent stages within the
same run reuse it. An explicit `PORT` environment variable in the agent's
invocation MUST take precedence over the computed port.

```typescript
interface PortAllocator {
  /** Returns the deterministic candidate port for this worktree path. */
  candidate(worktreePath: string, basePort?: number): number;

  /**
   * Returns the actually-bound port (deterministic candidate or first
   * free probe). Records the resolved port in runtime.json.
   */
  allocate(worktreePath: string, basePort?: number): Promise<number>;
}
```

When a stage requires more than one port (e.g., dev server + websocket),
the additional ports are allocated as `port + 1`, `port + 2`, ... up to a
maximum of 10 contiguous ports.

## Artifact directory convention

Every parallel run writes artifacts under
`$ARTIFACTS_DIR/<issue-id>/` (per-issue) and
`$ARTIFACTS_DIR/_pipeline/`, `$ARTIFACTS_DIR/_ledger/`, and
`$ARTIFACTS_DIR/_classifier/` (pipeline-wide). Stage outputs are emitted
as paired files: a human-narrative `.md` operator-friendly file AND a
schema-conformant `.json` machine-readable file (RFC-0010 §16.1, §16.4).

The contract between stages is the JSON file, not the markdown. Adapters
MUST include the relevant schema in their invocation prompt, write the
JSON atomically, validate it against the schema before declaring stage
success, and on validation failure retry once with a sharpened prompt
naming the validator error before failing the stage with
`ArtifactSchemaInvalid` (RFC-0010 §13.9, §16.4).

> **Status: schemas in `spec/schemas/artifacts/`.** As of this writing the
> directory ships five schemas — `plan.schema.json`,
> `implementation.schema.json`, `validation.schema.json`,
> `review.schema.json`, `pr.schema.json`. The remaining schemas referenced
> by the RFC's event surface (`HarnessResult`, `BurnDownReport`,
> `EstimateBootstrapped`, `MigrationDiverged`, classifier output) are
> pending follow-up tasks. The "adapters MUST validate against the schema
> in `spec/schemas/artifacts/`" requirement is therefore aspirational for
> any artifact whose schema has not yet landed; once the missing schemas
> ship, this status note will be removed and the assertion becomes hard.

## See also

- [RFC-0010 — Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) — full normative spec
- [Operator runbook](../operations/operator-runbook.md) — operator workflow that consumes these interfaces
- [Adapter authoring guide](../operations/adapter-authoring.md) — how to author a new HarnessAdapter or DatabaseBranchAdapter
- [Runners](runners.md) — the legacy single-agent runner abstraction RFC-0010 generalizes from
