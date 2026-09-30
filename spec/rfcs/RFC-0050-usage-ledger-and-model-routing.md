---
id: RFC-0050
title: Usage Ledger and Evidence-Based Model Routing
status: Approved
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-09-30
updated: 2026-09-30
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0004, RFC-0010, RFC-0016, RFC-0023, RFC-0035, RFC-0041, RFC-0049]
requiresDocs:
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: '2026-11-30'
---

# RFC-0050: Usage Ledger and Evidence-Based Model Routing

**Status:** Signed Off (2026-09-30, Engineering + Operator) — **all 3 Open Questions
resolved via operator rubric walkthrough.** Resolutions: **(OQ-1)** the ledger ingests every Claude Code and
Codex session on the machine as token counts only; projects without `.ai-sdlc/`
collapse into one `other` bucket with no paths or task detail; **(OQ-2)** routing
evidence comes from observed outcomes, deterministic exploration on a small share of
trusted tasks, and offline replay for reviewer models; the security reviewer is never
explored live; **(OQ-3)** table changes are asymmetric: a move to a cheaper model is
proposed with evidence in one weekly Decision and needs approval (silence means no
change), a move back to a stronger model after measured inferiority applies
automatically; bar: at least 30 compared tasks and a first-pass approval rate within 5
points. Phase tasks AISDLC-648 to AISDLC-659.

## Summary

Two connected capabilities.

**Part A, the usage ledger.** One normalized record for every model call made on the
operator's machine: model, input, cache-write, cache-read and output tokens, the agent
role that made the call, the task it served and the billing pool it drew from. Records
are ingested from the harnesses' own transcripts (Claude Code and Codex first) and
reported directly by framework code that calls a model itself. From the ledger the
framework reports usage per model, role, task and subscription window, and tracks how
the subscription allotment changes over time.

**Part B, evidence-based routing.** The ledger is joined to outcomes the framework
already records (review verdicts, iteration counts) to give quality and cost per role,
model and task class. A deterministic exploration mechanism and an offline reviewer
replay supply the comparisons that pinned roles cannot. The result is a routing table,
keyed by role and task class, in which every entry cites its evidence. Tasks are routed
from the table automatically; the table itself changes under an asymmetric rule.

## Motivation

### The framework does not see the calls it is responsible for

Inspected on the operator machine, 2026-09-30:

| Tracking surface | State |
| --- | --- |
| `cost_ledger` table in `.ai-sdlc/state.db` (RFC-0004) | 0 rows |
| `SubscriptionLedger` (RFC-0010 §14) | No caller outside its own module; no ledger file on disk |
| `SubscriptionPlan` config, `modelSelection` rules | Absent from this repo's `.ai-sdlc/`; `selectModel()` is called only from `orchestrator/src/execute.ts` |
| `DEFAULT_MODEL_COSTS` | Five models, none of those in the table below; an unknown model is silently priced as Sonnet |
| Transcript-leaf `model` field | Written from a fixed default (`claude-sonnet-4-6`) in `execute.md`, not from the call |

The cause is structural, not an omission in one module. `cost_ledger` is written by
`orchestrator/src/execute.ts` and the advisor's `track_usage` tool. The dogfood path
runs slash commands inside a Claude Code session and goes through neither. In that
path the framework's code never makes the model call. The harness does, so the
framework cannot count tokens by instrumenting its own call sites.

### The harness records every call

Claude Code writes a transcript per session and per subagent. Every assistant message
carries a usage block (input, cache-creation split by 5-minute and 1-hour tiers,
cache-read, output, reasoning tokens), the model id, a request id, a timestamp, the
session id and the working directory. Each subagent transcript has a sidecar
(`agent-<id>.meta.json`) naming its agent type. Codex session files carry
`token_count` events. The data needed for Part A already exists; nothing reads it.

Aggregated from the transcripts on the operator machine (2026-06-12 to 2026-09-30,
17,635 model calls after deduplication):

| Agent type | Calls | Cache write | Cache read | Output |
| --- | ---: | ---: | ---: | ---: |
| main session (conductor, operator sessions) | 4,248 | 31.1M | 1,925M | 4.7M |
| `ai-sdlc:developer` | 7,343 | 19.6M | 1,172M | 0.5M |
| `ai-sdlc:code-reviewer` | 2,312 | 10.5M | 175M | 0.2M |
| `ai-sdlc:test-reviewer` | 1,981 | 8.2M | 153M | 0.1M |
| `ai-sdlc:security-reviewer` | 1,033 | 11.5M | 75M | 0.1M |
| all other agent types | 718 | 4.8M | 47M | 0.2M |

| Model | Calls | Cache read |
| --- | ---: | ---: |
| `claude-sonnet-5` | 10,242 | 1,382M |
| `claude-opus-4-8` | 3,621 | 1,286M |
| `claude-opus-5` | 1,301 | 530M |
| all other models | 2,471 | 349M |

Four properties of this data constrain the design:

1. **Cache reads are nearly all the volume**: about 3.5 billion cache-read tokens
   against 5.8 million output tokens. Consumption is driven by context size multiplied
   by the number of turns, not by what the model writes. A tracker that records only
   input and output, as `cost_ledger` does, misses almost everything.
2. **The main session is the largest consumer**, above the developer agent and about
   five times the three reviewers combined. The figure is an undercount: only three
   main-session files survive (the oldest from 2026-09-19), while subagent files reach
   back to June. No policy routes or budgets the main session today.
3. **Naive counting doubles the totals.** 17,432 usage lines in the transcripts repeat
   a message already counted. Records must be deduplicated by message id.
4. **The raw data expires.** The harness prunes old transcripts. History that is not
   ingested before it is pruned is lost.

### Routing has no evidence to stand on

Models are assigned by role: agent frontmatter pins developer and the code and test
reviewers to Sonnet and the security reviewer to Opus. RFC-0010 §20.5 rejected
adaptive model selection for v1 for lack of telemetry. That is still the position.
Two facts keep it there:

- Because roles are pinned, history contains almost no within-role variation. Observed
  outcomes cannot say whether a different model would have done as well.
- Quality is recorded (the AISDLC-616 reviews ledger holds per-reviewer verdicts and
  iteration numbers) but is not joined to which model did the work or what it cost.

## Goals

1. Record every model call on the operator's machine once, with input, cache-write,
   cache-read and output tokens per model, regardless of which harness made it.
2. Attribute each call to an agent role, a task where one exists, and a billing pool.
3. Report usage per model, role, task, day and subscription window, as text, JSON and
   CSV, and in the operator TUI.
4. Keep per-model prices for input, output and cache tokens current by pulling them
   from published sources, with history, so cost comparisons use today's prices and
   past reports keep theirs.
5. Track the subscription allotment over time, so a change in what a plan provides is
   detected from data.
6. Produce quality and cost per role, model and task class from recorded outcomes.
7. Generate comparisons between models without running work twice, and replay past
   reviews offline where that is cheap.
8. Route tasks automatically from a reviewable table whose every entry cites evidence,
   and change that table only under a stated bar.

## Non-Goals

- **Storing content.** The ledger holds counts, ids and attribution. It never stores
  prompts, responses, file contents or tool output.
- **Billing reconciliation.** API-equivalent cost is an estimate for comparison. It is
  not an invoice and is not reconciled against the provider.
- **Reverse-engineering the provider's metering.** How a subscription converts tokens
  into "percent used" is not published. The ledger records raw tokens and calibrates
  against observed readings; it does not claim to know the formula.
- **Routing between harnesses.** Whether a review runs on Claude Code or Codex stays as
  configured (RFC-0010 §13). The table chooses a model within the configured harness.
- **Changing the operator's own session model.** The main session's model is the
  operator's choice. The RFC reports its cost and does not switch it.
- **Budget-pressure downshift.** RFC-0004 §3 specifies it. It remains a separate
  mechanism and is not given authority over the routing table here.
- **Upstream telemetry.** Nothing in the ledger leaves the machine (RFC-0045 governs
  any upstream reporting).
- **Developer-task replay.** Replaying whole developer tasks offline costs a full run
  per data point and is left out of v1 (OQ-2).

## Proposal

### Part A: the usage ledger

#### A1. The record

One record per model call, append-only:

```ts
export interface ModelCallRecord {
  schemaVersion: 'v1';
  callId: string;               // provider message id; the deduplication key
  requestId?: string;
  ts: string;                   // ISO timestamp of the call
  harness: 'claude-code' | 'codex' | 'opencode' | 'direct';
  provider: string;             // 'anthropic', 'openai', 'typesafe', ...
  model: string;                // exact id as reported by the call
  tokens: {
    input: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
    output: number;
    reasoning?: number;         // subset of output where reported
  };
  billingPool: 'subscription-interactive' | 'agent-sdk-credit' | 'api-key' | 'codex-plan' | 'pay-per-token' | 'unknown';
  sessionId: string;
  agentId?: string;
  agentRole: string;            // 'main-session', 'ai-sdlc:developer', ...
  scope: 'framework' | 'other'; // OQ-1
  repo?: string;                // framework scope only
  taskId?: string;              // framework scope only
  source: { file: string; offset: number };  // omitted for scope 'other'
}
```

The ledger is machine-level, because a subscription is per account and spans
repositories: `~/.ai-sdlc/usage/ledger-YYYY-MM.jsonl` (override with
`AI_SDLC_USAGE_DIR`). It is never committed. JSONL keeps it consistent with every other
framework substrate and readable with `jq`.

#### A2. Ingestion

Three kinds of source feed the same record shape:

- **Harness transcript ingesters.** One per harness. The Claude Code ingester reads
  session and subagent transcripts under the harness's projects directory; the Codex
  ingester reads `token_count` events from Codex session files; an opencode ingester
  follows once that harness adapter is merged. Each is incremental (a byte offset per file is kept in
  `cursors.json`) and idempotent (a call already in the ledger is skipped by `callId`).
- **Direct reporters.** Framework code that calls a model itself reports the call
  through `recordModelCall()`: the judgment layer (RFC-0049), the API-key review and
  triage runners (whose `tokenUsage` is currently dropped), and embedding adapters.
- **Backfill.** `cli-usage ingest --backfill` reads everything still on disk.

Ingestion runs from the plugin's existing `Stop` and `SessionStart` hooks, at the start
of each orchestrator tick, and on demand. It must never block or slow a session: it
runs detached with a time limit, and any failure is swallowed and reported as a
degraded capability (RFC-0049 section 9), not as an error to the user.

#### A3. Attribution

- **Agent role** comes from the subagent sidecar's `agentType`; a session transcript
  is `main-session`.
- **Scope (OQ-1).** A call whose working directory is inside a repository that has an
  `.ai-sdlc/` directory is `framework` scope and keeps its repository and source.
  Every other call is `other` scope: tokens, model, timestamp and harness are kept;
  repository, task, working directory and source file are not written.
- **Task** is resolved, for framework scope, from the worktree path
  (`.worktrees/<task-id>`), then the branch name, then the `.active-task` sentinel.
  A call with no resolvable task is recorded without one.
- **Billing pool** follows RFC-0041 §4.1: an interactive Claude Code session and its
  in-session subagents are `subscription-interactive`; a `claude -p` or SDK entrypoint
  is `agent-sdk-credit`; a call made with an API key is `api-key`; Codex is
  `codex-plan`; the judgment provider is `pay-per-token`. Where the transcript does not
  make the entrypoint clear the pool is `unknown`, never guessed.

#### A4. Allotment tracking

The provider reports subscription consumption as a percentage of a window (a rolling
session window and a weekly window) and does not publish the conversion from tokens.
The ledger therefore works from both ends:

- **Weighted units.** Each call is converted to units with configurable weights per
  token class and per model family. The defaults use the provider's public API price
  ratios as a proxy. They are a starting point and are labelled as such in every
  report.
- **Calibration snapshots.** `cli-usage snapshot --window weekly --used-pct 42` records
  the percentage the provider shows at that moment. Where a harness exposes limit
  information in its session data, the ingester records it automatically.
- **Implied allotment.** For each snapshot: units consumed in the window divided by the
  percentage used. The series of implied allotments over time is the record the
  operator asked for. A shift beyond a configured tolerance between snapshots with a
  similar model mix is reported as a probable allotment change.
- **Limit events.** Rate-limit and limit-reached messages found in transcripts are
  recorded as events with their timestamps.

`.ai-sdlc/usage-config.yaml` (or the machine-level equivalent) holds the plan name, its
windows and monthly price, the unit weights and the tolerance.

#### A5. Reports

`cli-usage report` groups by any of model, agent role, task, repository, billing pool,
day or window, over a date range, as text, JSON or CSV. Each row shows calls and the
five token classes separately, weighted units, and API-equivalent cost. Three fixed
views answer the recurring questions:

- **Window view:** units used in the current session and weekly windows, the implied
  allotment, and the projected time to the limit at the current rate.
- **Task view:** tokens and units per task, split by role, so the cost of a task is
  one number.
- **Context overhead view:** for each session, the size of the context at the first
  call (the fixed prefix every later turn re-reads) and the number of turns. Since
  cache reads dominate, this is where reductions are found.

API-equivalent cost uses the price history described in A6. A model with no price is
reported as `unpriced`. It is never priced as another model. The same rule replaces the
Sonnet fallback in `CostTracker.computeCost`.

The operator TUI (RFC-0023) gains a usage pane showing the window view and the top
consumers.

#### A6. Price feed

Per-token prices for input, output, cache write and cache read change, and new models
arrive with their own. A table maintained by hand drifts: on 2026-09-30 the repo's
`DEFAULT_MODEL_COSTS` listed `claude-haiku-4-5` input at $0.80 per million tokens while
a public price index listed $1.00, and it had no row at all for the three models that
account for most of this repo's usage. Prices are therefore pulled, not typed.

- **Sources.** A `PriceSource` adapter returns, per model id, the price per million
  tokens for input, output, cache read, 5-minute cache write and 1-hour cache write,
  with the URL and fetch time. Providers publish prices on web pages; whether a given
  provider also offers a machine-readable price endpoint is checked when its adapter is
  written, and that endpoint is used where it exists. Two public, machine-readable
  indexes that carry all five token classes were confirmed reachable on 2026-09-30 and
  ship as the first adapters: the OpenRouter models endpoint and the LiteLLM price
  file. They are third-party aggregators, so they are treated as untrusted input.
- **Refresh.** `cli-usage prices refresh` runs at most once a day from the orchestrator
  tick and on demand. It only fetches public URLs; it sends nothing about the repo.
- **History, not a table.** Every observed price is appended to
  `prices.jsonl` with model, the five prices, source, URL, fetch time and an effective
  date. A call is priced with the row in effect at the call's timestamp, so a past
  report does not change when a price does.
- **Validation.** A fetched row is rejected when a price is zero, negative or
  non-numeric. When two sources disagree by more than a tolerance, or a price moves by
  more than a configured factor since the last row, the new row is recorded as `held`
  and is not used until the operator confirms it. A `manual` row entered by the
  operator always wins over a fetched one.
- **Failure.** When no source can be reached the last known prices stay in force and
  are marked stale after a configured number of days. The `pricing.feed` capability
  reports `degraded` (RFC-0049 section 9).
- **Effect on decisions.** A price change emits `ModelPriceChanged`. The default unit
  weights (A4) are derived from current price ratios, so which model counts as
  "cheaper" in B5 follows the feed. The weekly proposal is always computed at current
  prices, and it reports any cell whose applied change is no longer cheaper.

For subscription work the per-token price is not what the operator pays. It serves two
purposes here: a consistent proxy for weighing one model's tokens against another's,
and the API-equivalent figure that shows what the same work would cost outside the
plan.

### Part B: evidence-based routing

#### B1. Outcomes and scorecards

Quality is defined per role from data the pipeline already writes:

| Role | Outcome signals | Source |
| --- | --- | --- |
| developer | first-pass approval (every reviewer approves at iteration 1 with no critical or major finding); iterations to approval; contract retries | reviews ledger (AISDLC-616), orchestrator events |
| reviewer | on replayed diffs: share of known-defect diffs blocked (recall), share of clean diffs blocked (false-block rate) | reviewer replay (B4) |
| conductor | tokens and units per reconciled PR | usage ledger |

`cli-usage scorecard` joins the usage ledger, the reviews ledger and the assignment log
(B3) by task and role and reports, per role, model and task class: number of tasks,
first-pass approval rate, mean iterations, and mean units per task. Task class is the
estimation class already defined by RFC-0016 (`bug`, `feature`, `chore`,
`uncategorized`). T-shirt size is recorded on each row and is not a table key in v1, to
keep cells few enough to fill.

Every rate is shown with its count. A cell with fewer than 30 tasks is labelled
insufficient and is not used for a table change.

#### B2. The routing table and resolver

`.ai-sdlc/model-routing.yaml`, read from the base branch only:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
spec:
  strength: [haiku, sonnet, opus]      # weakest to strongest; defines "stronger"
  exploreShare: 0.10                   # share of eligible tasks sent to a candidate
  cells:
    developer:
      chore:   { model: sonnet, candidates: [haiku] }
      bug:     { model: sonnet }
      feature: { model: sonnet, candidates: [opus] }
    code-reviewer:
      '*':     { model: sonnet }
    security-reviewer:
      '*':     { model: opus }         # never explored live
  evidence:
    developer.chore:
      report: .ai-sdlc/routing-evidence/2026-10-21-developer-chore.json
      n: 34
      firstPassApproval: 0.88
```

`resolveModel({role, taskClass, taskId, sourceKind})` is a pure function of the table,
the overrides file (B5) and the task id. With no file present it returns exactly what
each role uses today, so behaviour is unchanged until a repo adopts a table.

The resolver is consulted wherever a model is chosen for a role: the Tier 2 spawner's
per-role defaults, and the step tools that build developer and reviewer prompts, which
return the resolved model so the slash command can pass it on the agent call. The
transcript leaf's `model` field is written from the resolved model, replacing the fixed
default.

#### B3. Exploration

A cell with `candidates` sends a share of eligible tasks to a candidate instead of the
cell's model. Assignment is deterministic: a hash of the task id, the role and a salt
in the table selects the arm, so the same task always resolves the same way and an
assignment can be audited after the fact.

Eligibility, from the OQ-2 resolution:

- `sourceKind` must be `backlog`. Work from external issues is never explored.
- The security reviewer has no live exploration. A `candidates` entry on that role is a
  configuration error.
- A task on its second or later iteration keeps the arm it started with.

Every resolution is appended to an assignment log (task, role, task class, arm, model,
reason: `table`, `explore`, `override` or `default`). That log is what makes an outcome
attributable to a model, and what separates an explored comparison from a pinned one.

#### B4. Reviewer replay

Reviewer models are compared offline. A corpus is built from merged work: for each
reviewed commit in the reviews ledger, the diff that was reviewed and a label. A diff is
`known-defect` when a critical or major finding was raised on it and a later iteration
was approved; it is `clean` when it was approved at iteration 1. `cli-usage replay`
runs a reviewer role with a candidate model over the corpus through the existing
spawner and scores the binary result (block or approve) against the label: recall on
known-defect diffs, false-block rate on clean diffs, and units per review.

Replay spends allotment, so it takes an explicit task count and unit budget, stops when
either is reached, and can be scheduled through the existing off-peak scheduling
module. Replay reviews are never written to the reviews ledger, the transcript leaves
or any attestation.

#### B5. How the table changes

From the OQ-3 resolution:

- **To a cheaper model: proposed, then approved.** A weekly job evaluates each cell's
  candidates. A candidate qualifies when it has at least 30 compared tasks and its
  first-pass approval rate is no more than 5 points below the cell's current model over
  the same period (for a reviewer role: replay recall no more than 5 points lower and
  false-block rate no more than 5 points higher). All qualifying changes go into one
  Decision (RFC-0035) with the evidence attached. Approval produces a pull request that
  edits the table and records the evidence reference. Silence leaves the table as it
  is.
- **Back to a stronger model: automatic.** When a cell's model, after a change, shows a
  first-pass approval rate more than 5 points below the rate recorded in the evidence
  that justified the change, over at least 30 tasks, the resolver reverts that cell to
  its previous model through an overrides file
  (`$ARTIFACTS_DIR/_routing/overrides.json`). An override can only move a cell to a
  model that is stronger in the table's `strength` order. It is recorded, announced
  through a Decision, and stays until a table change supersedes it.

Both numbers (30 and 5 points) are configuration with those defaults.

## Design Details

### Schema Changes

- New: `spec/schemas/usage-config.v1.schema.json` (`UsageConfig`).
- New: `spec/schemas/model-routing.v1.schema.json` (`ModelRouting`).
- New: `spec/schemas/model-call-record.v1.schema.json` (the ledger record).
- `spec/schemas/orchestrator-events.v1.schema.json`: additive event types
  `UsageLimitObserved`, `AllotmentChangeSuspected`, `ModelRoutingOverrideApplied`,
  `ModelPriceChanged`.
- No change to the verdict schema or the attestation envelope. The transcript leaf's
  existing `model` field becomes accurate.

### Behavioral Changes

With no `model-routing.yaml`, model selection is unchanged. Ingestion and reporting are
additive: they read harness files and write only under the usage directory. A repo that
adopts a table with `candidates` will see a configured share of trusted tasks run on a
candidate model.

### Privacy and Storage

- The ledger stores no content. `other`-scope records carry no path, repository or task.
- The ledger is machine-local and uncommitted. Reports the operator chooses to commit
  (evidence files for table changes) contain aggregates for this repository only.
- The ingester opens transcripts of unrelated projects to read their usage fields
  (OQ-1). `AI_SDLC_USAGE_SCOPE=framework-only` restricts it to framework repositories
  for an operator who does not want that.
- In a remote sandbox the ingester is a no-op.

### Relationship to Existing Cost Code

- `cost_ledger` (RFC-0004) remains for the `orchestrator` execute path. `cli-cost-report`
  reads the usage ledger as its primary source; the SQLite table becomes one of its
  inputs.
- `SubscriptionLedger` (RFC-0010 §14) was designed to meter admission from framework
  calls it never sees. Its window and pacing logic is reused with the usage ledger as
  the source of consumed tokens.
- The capabilities `usage.ingest` and `routing.table` are registered in the RFC-0049
  section 9 registry, so an ingester that stops working shows as degraded in doctor.

### Migration Path

Additive. The first run performs a backfill of whatever transcripts remain on disk.

## Backward Compatibility

Not a breaking change. No existing resource needs modification. Adopters who add no
configuration get the usage ledger and reports and no change to routing.

## Alternatives Considered

### Alternative 1: Instrument the framework's own model calls

This is the existing design (`CostTracker.recordCost`). It records nothing on the
dogfood path, because the framework does not make those calls. It is kept for the
calls the framework does make and cannot be the primary source.

### Alternative 2: OpenTelemetry export from the harness as the source

Claude Code can export usage metrics over OpenTelemetry. That is account-wide and
live. It needs a collector to be running, has no backfill, and its metrics do not carry
the task and subagent attribution that the transcript sidecars do. It is a good second
source for a later phase and is not the primary one.

### Alternative 3: Depend on a community usage tool

Tools that read the same transcripts exist and validate the approach. Taking one as a
dependency would put a third-party parser of an undocumented file format into the
governance path, and none attributes calls to tasks or agent roles. The ingester is
small and is covered by fixtures.

### Alternative 4: Meter through a proxy

Routing every model call through a local gateway would count tokens exactly. A
subscription session cannot be pointed at such a proxy, and it would add a component
whose failure stops all work.

### Alternative 5: Offline replay as the only evidence

Rejected in OQ-2. A developer replay is a full extra run per data point. Exploration
gets the same comparison from work that was going to run anyway.

### Alternative 6: A continuous bandit in place of a table

Rejected in OQ-3. It adapts fastest and leaves no stable artifact to read, diff or cite.

## Implementation Plan

Twelve phase tasks. Part A has no dependency on Part B and delivers value by itself.

- **AISDLC-648 — ledger core.** Record schema, JSONL store, deduplication, cursors,
  `recordModelCall`, price table with `unpriced`.
- **AISDLC-649 — Claude Code ingester.** Incremental transcript ingestion, attribution,
  scope collapse (OQ-1), limit events, `cli-usage ingest`, hook and tick wiring.
  Depends on 648.
- **AISDLC-650 — other sources.** Codex ingester; direct reporters for the API
  runners and embeddings. Depends on 648.
- **AISDLC-651 — reports and allotment.** `cli-usage report`, the three fixed views,
  weighted units, snapshots, implied allotment and change detection, usage config.
  Depends on 649.
- **AISDLC-652 — TUI usage pane.** Depends on 651.
- **AISDLC-653 — scorecards.** Outcome join and `cli-usage scorecard`. Depends on 651.
- **AISDLC-654 — routing table, resolver and exploration.** Schema, base-branch loader,
  `resolveModel`, deterministic exploration, assignment log, wiring into the spawner,
  the step tools and the transcript leaf. Depends on 649.
- **AISDLC-655 — reviewer replay.** Corpus builder, `cli-usage replay`, budget and
  off-peak scheduling. Depends on 653.
- **AISDLC-656 — table changes.** Weekly proposal Decision, approval to pull request,
  automatic override to a stronger model (OQ-3). Depends on 653 and 654.
- **AISDLC-657 — docs.** Operator runbook for usage and routing. Depends on 651 and 654.
- **AISDLC-658 — backfill and baseline.** Operator-only, non-dispatchable: backfill
  before transcripts are pruned, first reports, first snapshots, initial table.
  Depends on 649, 651 and 654.
- **AISDLC-659 — price feed.** `PriceSource` adapters, daily refresh, price history,
  validation and `held` rows, `ModelPriceChanged`. Depends on 648.

## Open Questions

**OQ-1 — Whose sessions does the ledger ingest?** A subscription allotment is per
account and is consumed by every session on every project. Should the ledger read only
repositories that use the framework, or every session on the machine, and with how much
detail?

**Resolution (2026-09-30, full rubric): every Claude Code and Codex session is
ingested as token counts; projects without `.ai-sdlc/` collapse into one `other`
bucket.** Industry research: community usage tools for Claude Code read every
transcript under the projects directory and deduplicate by message and request id;
the harness can also export account-wide usage over OpenTelemetry, without backfill or
task attribution; RFC-0045 set this repo's precedent that data about an environment is
consent-gated. **Substrate surveyed:** eleven project directories exist on the operator
machine; subagent sidecars carry the agent type; the working directory distinguishes
framework repositories. **Refinement:** `other`-scope records omit repository, task,
working directory and source file; `AI_SDLC_USAGE_SCOPE=framework-only` opts out of
reading unrelated transcripts. **Counter-argument:** "A governance framework has no
business opening transcripts from other projects." Rebuttal: it stores counts and ids,
never content, and discards even the path for unrelated work; without those counts the
remaining-allotment figure is a guess whenever the operator works elsewhere.
**Selected over framework-repos-only** because allotment tracking is the stated goal
and that option cannot deliver it reliably, **and over full per-project detail**
because that adds exposure and no decision value.

**OQ-2 — Where does routing evidence come from?** Choosing the cheapest adequate model
for a role needs quality per model for that role. Observed history, randomised
exploration in production, and offline replay differ in token cost, time to an answer
and validity. Which does v1 use?

**Resolution (2026-09-30, full rubric): observed outcomes, plus deterministic
exploration on a small share of trusted tasks, plus offline replay for reviewer models
only.** Industry research: SWE-bench scores an agent by running the real fix's tests
against its patch, a method that transfers to a single repository because merged task
PRs carry their tests; randomised assignment in production is the standard way to
compare alternatives without extra runs. **Substrate surveyed:** roles are pinned by
agent frontmatter, so within a role history holds almost no model variation and
observation alone cannot compare models; from the operator machine's data a developer
run costs roughly ten times a review in tokens, which makes developer replay the
expensive eval and reviewer replay the cheap one. **Refinement:** exploration is
limited to `sourceKind` `backlog`; the security reviewer is never explored live and is
compared only by replay; assignment is a deterministic hash so it is reproducible and
auditable; every resolution is logged. **Counter-argument:** "Exploration deliberately
runs real work on a model believed to be worse, and the cost is paid in iterations."
Rebuttal: the share is small and configurable, CI and reviewers still gate the result,
and an extra iteration costs far less than the second full developer run that offline
replay spends on every data point. **Selected over observation only** because that
cannot answer the question, **and over offline replay only** because it buys the same
evidence at several times the token cost.

**OQ-3 — Who changes the routing table, and against what bar?** Tasks are routed
automatically from the table. How does the table itself change once evidence exists?

**Resolution (2026-09-30, full rubric): asymmetric.** A move to a cheaper model is
proposed with its evidence in one weekly Decision and needs approval; silence means no
change. A move back to a stronger model after measured inferiority applies
automatically through a strength-only override. Bar for a cheaper model: at least 30
compared tasks and a first-pass approval rate no more than 5 points below the current
model's. Industry research: RFC-0049's promotion rule (operator decision, same day)
already makes the scrutiny-reducing change the one that cannot be self-approved;
RFC-0010 §14.13 prefers event-count tiers to continuous confidence; non-inferiority is
the standard test for a cheaper alternative. **Refinement:** proposals are batched so
the operator answers at most one Decision a week; the override file can only select a
model stronger in the table's declared order, so it cannot be used to cut cost; both
numbers are configuration. **Counter-argument:** "A weekly approval is the decision
fatigue the operator keeps flagging." Rebuttal: routing is automatic and only changes
toward cheaper models wait; there are about twenty cells; and a downshift is the one
change that can lower quality across every task in a cell with nobody looking.
**Selected over fully automatic** for that reason, **over report-only** because
evidence would exist and nothing, including a needed upshift, would happen, **and over
a continuous bandit** because a table can be read, diffed and cited.

## References

- Tracking surfaces: `orchestrator/src/cost-tracker.ts`, `orchestrator/src/defaults.ts`,
  `orchestrator/src/scheduling/ledger.ts`, `orchestrator/src/scheduling/tier-analysis.ts`,
  `orchestrator/src/scheduling/off-peak.ts`, `pipeline-cli/src/cli/cost-report.ts`,
  `mcp-advisor/src/tools/track-usage.ts`.
- Model selection: `reference/src/policy/model-selection.ts`,
  `pipeline-cli/src/runtime/shell-claude-p-spawner.ts`, `ai-sdlc-plugin/commands/execute.md`,
  `ai-sdlc-plugin/plugin.json` (hooks).
- Outcomes: `pipeline-cli/src/cli/reviews.ts` (AISDLC-616 reviews ledger),
  `pipeline-cli/src/orchestrator/events.ts`, `pipeline-cli/src/estimation/types.ts`.
- `docs/operations/billing-and-cost-optimization.md`.
- Price indexes checked 2026-09-30: the OpenRouter models endpoint (per-model `pricing`
  with prompt, completion, cache read and both cache-write tiers) and the LiteLLM
  `model_prices_and_context_window.json` file.
- [[RFC-0004]] (cost governance); [[RFC-0010]] §11, §14, §20.5 (model routing,
  subscription scheduling, adaptive selection rejected for lack of telemetry);
  [[RFC-0016]] (task class); [[RFC-0023]] (operator TUI); [[RFC-0035]] (Decisions);
  [[RFC-0041]] §4.1 (billing pools); [[RFC-0049]] (judgment layer as a direct reporter;
  capability liveness).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ✅ Signed (measures at the harness, where the calls are made; one deduplicated record per call; routing is a pure lookup with a logged reason; no table file means no behaviour change; 2026-09-30) |
| Operator | Dominique Legault | ✅ Signed (per-model usage and allotment tracking from real data; cheaper models need evidence and approval, quality regressions revert automatically; 2026-09-30) |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-09-30 | Initial version, born `Signed Off` (Engineering + Operator). Evidence from the operator machine (empty `cost_ledger`, unwired `SubscriptionLedger`, 17,635 model calls aggregated from harness transcripts). Part A usage ledger, Part B evidence-based routing. 3 Open Questions resolved via operator rubric walkthrough. Section A6 (price feed) added at the operator's request before first publication. Phase tasks AISDLC-648 to AISDLC-659. Trigger: operator request for per-model usage tracking and an evidence-backed cost strategy. |
