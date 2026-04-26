# RFC-0010: Parallel Execution and Worktree Pooling

**Document type:** Normative (draft)
**Status:** Draft v1 — pending review
**Created:** 2026-04-26
**Authors:** Dominique Legault (CTO / Engineering Authority)
**Reviewers:** TBD
**Spec version:** v1alpha1
**Requires:** RFC-0002 (Pipeline Orchestration), RFC-0008 (PPA Triad Integration)
**Amends:** RFC-0002 §3 (Stage object), §5 (Branching), §9 (reconciliation semantics); RFC-0004 §4 (cost attribution per stage)

---

## Sign-Off

| Person | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority | ✅ Signed | 2026-04-26 |
| Morgan Hirtle | Chief of Design / Design Authority | ⏳ Pending | — |
| Alexander Kline | Head of Product Strategy / Product Authority | ⏳ Pending | — |

---

## Revision History

| Version | Date | Summary |
|---|---|---|
| v1 | 2026-04-26 | Initial draft. Defines worktree pool, deterministic port allocator, parallelism caps, merge coordination. Cites Archon (`coleam00/Archon`) as prior art for the deterministic port-hash and worktree adoption patterns. |
| v2 | 2026-04-26 | Added per-stage model routing (amends RFC-0004 §4) and the conditional review fan-out pattern. Both were originally scoped out; bundled in after CTO direction to keep parallel-execution wins in one document. |
| v3 | 2026-04-26 | Added per-stage harness selection. Harness (`claude-code`, `codex`, `gemini-cli`, `opencode`, `aider`, `generic-api`) is now orthogonal to model — Claude Code can drive non-Claude models via Bedrock/Vertex/custom endpoints, and OpenCode/Aider can drive Claude. Defines the HarnessAdapter interface, capability matrix, and fallback chain. Enables cross-harness review (e.g., Codex reviewing Claude's PR). |
| v4 | 2026-04-26 | Added subscription-aware scheduling. Reframes cost optimization from per-call unit pricing to "maximize utility of fixed subscription windows" (Claude Code 5-hour quotas, off-peak 2× multipliers, monthly Codex caps). Introduces the SubscriptionLedger, per-stage `schedule` hints, off-peak deferral, and burn-down pacing. Goal: end every billing window having processed the maximum possible PPA-ordered work without exceeding quota. |
| v5 | 2026-04-26 | Added per-worktree database isolation (resolves Q1). Defines `DatabaseBranchAdapter` interface, ships adapters for SQLite copy-per-worktree, Neon branching, generic Postgres snapshot-restore, and `external` (operator-managed). Adds `DatabaseBranchPool` resource, per-stage `databaseAccess` declaration, connection-string rewriting, and migration coordination. Production Postgres clients no longer have to wait for RFC-0011. |
| v6 | 2026-04-26 | Resolved Q1 (cap default value). `Pipeline.spec.parallelism.maxConcurrent` is now optional, with a tier-aware default derived from declared `SubscriptionPlan`: no plan → 1 (today's behavior, no surprise regressions); `claude-code-pro` → 3; `claude-code-max-5x` → 5; `claude-code-max-20x` → 10. Couples parallelism opt-in to the same signal that says "I want subscription utilization to be maximized." |
| v7 | 2026-04-26 | Resolved Q2 (parallel-agent budget aggregation) by clarifying the three-axis cost model. `costBudget` (RFC-0004) is shared dollar-denominated across all parallel agents at pipeline scope. `SubscriptionPlan.windowQuotaTokens` is per-harness token-denominated, not per-agent. `Stage.maxBudgetUsd` is a per-stage circuit breaker, independent of either. Adds new §14.10 explaining how subscription quota maps to dollars (it doesn't directly — subscription work is pre-paid; only spillover to pay-per-token decrements `costBudget`). |
| v8 | 2026-04-26 | Resolved Q3 (PPA re-scoring on requeue). Hybrid algorithm: re-score when (time since last triage > 24h) OR (failure type signals difficulty miscalibration) OR (operator-triggered requeue). Adds normative §9.4 with the failure-type taxonomy classifying each known failure as transient (trust score) or intrinsic (re-score). Triage history persisted to `$ARTIFACTS_DIR/<issue-id>/triage-history.jsonl` for audit. |
| v9 | 2026-04-26 | Resolved Q4 (classifier failure-open scope). Classifier emits BOTH `confident: bool` (drives dispatch — the binary fall-open trigger) AND `confidence: float [0,1]` (informational, fed to calibration analysis). Validation rejects outputs where the two contradict (e.g., `confident: true` with `confidence < 0.7`). Operators can audit classifier calibration via `$ARTIFACTS_DIR/_classifier/calibration.jsonl` to detect overconfident or underconfident prompts and iterate. |
| v10 | 2026-04-26 | Resolved Q5 (model-deprecation handling). Model registry gains `deprecatedAt` / `removedAt` per entry. Pipeline-load resolves all aliases to physical IDs and pins them to `runtime.json` for the run's lifetime. Deprecated models still resolve but emit `ModelDeprecated` warning naming the removal date; removed models fail pipeline-load with `ModelRemoved`. Adds `cli-model-bump --dry-run` for operators to preview new resolutions before starting a pipeline run that picks them up. |
| v11 | 2026-04-26 | Resolved Q6 (adapter capability discovery vs declaration). Hybrid: static declaration is authoritative for pipeline-load validation; startup version probe is a sanity check against the installed CLI. Adds `requires: { binary, versionRange }` to the HarnessAdapter interface. Defaults to open-ended upper bounds (`>=X.Y.Z`) — assume forward-compatibility unless a specific upstream version is known to break compat. Probe parsing failures emit `HarnessProbeFailed` warning but do not block validation (avoids breaking on undocumented `--version` output changes). |
| v12 | 2026-04-26 | Resolved Q7 (cross-harness artifact format compatibility). Each artifact type produced by stages now has TWO files: a human-narrative `.md` (operator-friendly, harness-natural style) AND a schema-conformant `.json` (downstream-machine-readable, validated against `spec/schemas/artifacts/`). Adapters MUST include the relevant JSON schema in their invocation prompt and MUST produce a valid JSON file. Schema validation failure is a stage failure (`ArtifactSchemaInvalid`); adapter MAY retry once with a sharpened prompt before failing. Schemas are versioned via the `$schema` field for forward-compat. |
| v13 | 2026-04-26 | Resolved Q8 (fallback chain audit). Default behavior is transparent fallback with audit (`runtime.json` records actual harness used). Adds optional `Stage.requiresIndependentHarnessFrom: string[]` for stages where harness independence is a load-bearing safety property (e.g., `review-security` requires independence from `implement`). When set, the orchestrator filters the stage's harness chain to exclude harnesses that ran the named upstream stages. If no harness preserves independence, emits `IndependenceViolated` event and applies the stage's `onFailure` policy (`continue` advisory by default; operator MAY set `abort` for security-critical pipelines). |
| v14 | 2026-04-26 | Resolved Q9 (authoritative quota API migration). Adds `SubscriptionPlan.spec.quotaSource: 'self-tracked' (default) | 'authoritative-api' | 'authoritative-with-fallback'`. Operator opt-in (D); switching is pinned at pipeline-load. On first switch from self-tracked to authoritative, orchestrator emits one-time `LedgerReconciliation` event recording the divergence between self-tracked and authoritative utilization (B). Soft `QuotaSourceUpdateRecommended` warning when self-tracker drift is detectable after API is generally available. |
| v15 | 2026-04-26 | Resolved Q10 (off-peak schedule freshness). Adds `SubscriptionPlan.spec.offPeak.lastVerified: ISO 8601 date` for operator-declared freshness. At pipeline-load, missing or >30-day-old `lastVerified` emits `OffPeakScheduleStale` warning, surfaced to Slack digest (not just logs). `cli-status --subscriptions` view shows freshness age per plan. Reference SubscriptionPlan examples shipped with maintainer-verified dates, refreshed quarterly. |
| v16 | 2026-04-26 | Resolved Q11 (estimate cold-start). `Stage.estimatedTokens` is optional; missing falls through to default `{ input: 50000, output: 10000 }` with `MissingEstimate` warning. After first execution, rolling estimate replaces default and orchestrator emits one-time `EstimateBootstrapped` event recording the divergence. Operators MAY freeze the empirical estimate by writing it back to the pipeline YAML to opt out of rolling updates. Reference dogfood pipeline ships with `estimatedTokens` populated for all canonical stages so the default only affects novel operator-authored stages. |
| v17 | 2026-04-26 | Resolved Q12 (multi-tenant subscription pooling). SubscriptionLedger keys become `(harness, accountId, tenant)` instead of per-pipeline. `accountId` derived automatically from the harness's credentials via new `HarnessAdapter.getAccountId()` — auto-pools two pipelines on the same vendor account, auto-isolates two pipelines on different accounts. Optional `Pipeline.spec.tenant` + `tenantQuotaShare` carve a single account into virtual sub-windows for internal cost allocation. `LedgerPooled` event surfaces accidental account sharing; `LedgerKeyAmbiguous` warning when accountId can't be derived (degrades to per-pipeline ledger). |
| v18 | 2026-04-26 | Resolved Q13 (subscription tier upgrade signal). Adds weekly aggregated `TierAnalysis` writeup at `$ARTIFACTS_DIR/_ledger/tier-analysis.jsonl` per `(harness, accountId, tenant)`. Slack daily-digest entry surfaces only when `recommendedPlan` differs from `currentPlan` AND `confidence != 'low'` (no fatigue from "your tier is fine" notifications). `cli-tier-recommendation` command for ad-hoc deeper analysis. Recommendations cover both upgrades AND downgrades — operators waste money in either direction. |
| v19 | 2026-04-26 | Resolved Q14 (database branch warm pool). Adds `DatabaseBranchPool.spec.lifecycle.warmPoolSize: integer (default 0)`. When 0, behavior unchanged (current default — allocate on demand). When > 0, orchestrator maintains a pool of pre-allocated branches; stage allocation hands over a warm branch (sub-100ms) and asynchronously refills. Warm branches count against `maxConcurrent` and age out per `branchTtl`. Branches are single-use after reclaim (no recycle, avoids cross-contamination). Phase 6 integration test exercises the path even when nobody opts in. |
| v20 | 2026-04-26 | Resolved Q15 (migration rollback on PR abort). Adds `DatabaseBranchPool.spec.allowBranchFromBranch: boolean (default false)` topology guard — eliminates the divergence problem at the source for ~95% of pipelines that branch from stable upstream. When opt-in is set, reclamation of a branch with active children emits `MigrationDiverged` event naming the divergence; operator triages. No auto-reclaim, no auto-rebase, no auto-block at merge gate — divergence is informational, operator decides. **All 16 open questions resolved** (Q1 from the original list, then Q1–Q15 carried through the v6 renumbering). |

---

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Concepts](#5-concepts)
6. [Schema Amendments](#6-schema-amendments)
7. [Worktree Pool Manager](#7-worktree-pool-manager)
8. [Deterministic Port Allocator](#8-deterministic-port-allocator)
9. [Concurrency and Admission Control](#9-concurrency-and-admission-control)
10. [Merge Coordination](#10-merge-coordination)
11. [Per-Stage Model Routing](#11-per-stage-model-routing)
12. [Conditional Review Fan-Out](#12-conditional-review-fan-out)
13. [Harness Selection](#13-harness-selection)
14. [Subscription-Aware Scheduling](#14-subscription-aware-scheduling)
15. [Database Isolation](#15-database-isolation)
16. [Artifact Directory Convention](#16-artifact-directory-convention)
17. [Observability Requirements](#17-observability-requirements)
18. [Backward Compatibility](#18-backward-compatibility)
19. [Implementation Plan](#19-implementation-plan)
20. [Alternatives Considered](#20-alternatives-considered)
21. [Open Questions](#21-open-questions)
22. [References](#22-references)

---

## 1. Summary

This RFC extends the AI-SDLC pipeline (RFC-0002) with declarative semantics for **parallel execution of PPA-prioritized issues** through a **pooled git-worktree isolation model**, amends the cost-governance contract (RFC-0004) to support **per-stage model routing**, introduces **per-stage harness selection** so each stage can run on the most appropriate coding agent (Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider) regardless of the underlying LLM, and introduces **subscription-aware scheduling** that reframes cost optimization from "minimize per-call cost" to "maximize utility of fixed subscription windows."

Today, `orchestrator/src/execute.ts` drives one issue at a time through plan → build → review; every agent stage hardcodes Sonnet (`ai-sdlc-plugin/agents/*-reviewer.md`); the entire pipeline assumes Claude Code as the only harness; and the cost model assumes pay-per-token API pricing rather than the session-window quotas, off-peak multipliers, and monthly subscription caps that actually govern most coding-agent billing. To realize the dogfood pipeline vision at competitive unit economics, the orchestrator must run N agents concurrently without collisions, spend the right model on the right stage, fall over between harnesses, AND schedule work to fully consume each subscription window before it resets — including deferring lower-priority work to off-peak hours where Claude Code grants 2× the token allocation. This RFC defines the worktree pool, the port-allocation function, the concurrency cap, the merge serialization protocol, the artifact directory, the per-stage `model` and `harness` fields, the HarnessAdapter interface, the SubscriptionLedger that tracks remaining quota across windows, per-stage `schedule` hints that let operators say "this stage prefers off-peak" or "this stage MUST run within current quota," and the `DatabaseBranchAdapter` interface with shipped adapters for SQLite copy-per-worktree and Neon Postgres branching so parallel agents touching shared DB state don't corrupt each other's writes.

## 2. Motivation

### 2.1 Pipeline throughput is bottlenecked on serial execution

`orchestrator/src/execute.ts` dispatches a single agent against a single branch. With a PPA-ordered queue of N issues, end-to-end throughput is `N × T_issue`, regardless of how many models or seats are available. The Archon project (`coleam00/Archon`) demonstrates ~10× throughput gains by running parallel agents, each in its own worktree, against an ordered queue. We need the same capability.

### 2.2 Naive `claude --worktree` does not scale past ~3 agents

Three concrete failure modes appear once two or more agents share a host:

1. **Port collisions** — Two dev servers on `localhost:3000` race; the second crashes and the agent loops on a misleading "port in use" error.
2. **Branch collision in shared worktrees** — If a worktree is reused for a different issue, the agent's first `git status` reports unfamiliar uncommitted changes and may try to "fix" them.
3. **Cross-clone worktree adoption** — A worktree pointing at a different clone of the same repo silently corrupts both. Archon guards against this with `verifyWorktreeOwnership()` (`packages/git/src/worktree.ts`); we have no equivalent.

### 2.3 Merge ordering is currently undefined

When two agents finish at the same time, both attempt to push to the remote. There is no protocol for "agent A's PR rebases cleanly onto main; agent B's PR must rebase onto A's now-merged result." Without a serialized merge gate, the second PR fails CI on stale base, the agent retries, and we burn tokens re-running CI for a problem that should have been resolved before the human reviewer woke up.

### 2.4 Real-time observability is missing

Stored in memory (`feedback_observability.md`): *"black box execution destroys confidence; users need real-time visibility into agent progress."* Today, an operator running 5 agents in parallel has no way to know which issue each is on or which stage they are in without `tmux attach`-ing to each session. This RFC requires each parallel branch to publish a structured state file the operator (and a future dashboard) can read.

### 2.5 Every stage runs on Sonnet regardless of difficulty

`ai-sdlc-plugin/agents/code-reviewer.md`, `test-reviewer.md`, and `security-reviewer.md` all declare `model: sonnet`. The PPA triage stage and the review-classification step are pattern-matching tasks that Haiku handles well at ~10× lower cost. Conversely, complex implementation work in `/fix-pr` would benefit from Opus 1M but currently runs on Sonnet by default. The ratio of stage cost to stage difficulty is misaligned across the entire pipeline.

### 2.6 All three reviewers run on every PR

`/review` invokes the testing, critic, and security agents on every PR regardless of diff content. A README-only change runs the security reviewer; a config rename runs the test reviewer. Archon's flagship workflow (`archon-fix-github-issue.yaml`) uses a Haiku-cheap classifier (`review-classify`) that decides which reviewers to invoke based on diff scope. Adopting this pattern cuts review-stage cost by an estimated 40–60% on small PRs without losing coverage on PRs that need it.

### 2.7 The pipeline is locked to a single harness

Every stage today assumes Claude Code as the runtime. This creates four concrete risks:

1. **Vendor concentration.** A Claude Code outage, rate-limit, or pricing change halts the entire dogfood pipeline. Multiple clients running this product cannot tolerate single-vendor failure.
2. **Lost cost arbitrage.** Different harnesses + model providers have different unit economics for the same stage. An OpenRouter-routed DeepSeek call may cost 1/10th of a Sonnet call for a triage classification with comparable quality. Locking the harness forecloses this lever.
3. **Lost cross-harness review quality.** The Cole Medin transcript explicitly recommends `/codex adversarial-review` reviewing Claude's PR — a different model family in a different harness catches different classes of bugs. Single-harness pipelines lose this independence multiplier.
4. **Different harnesses, different strengths.** Codex CLI (OpenAI) excels at certain reasoning patterns; Gemini CLI handles long-context tasks well; Aider has strong refactoring; Claude Code has the richest skill/tool ecosystem. A pipeline that can route stages to the right harness extracts more value than one that uses any single tool for everything.

Notably, harness ≠ model. Claude Code can drive Bedrock-hosted Claude, Vertex-hosted Claude, or via `ANTHROPIC_BASE_URL` any OpenAI-compatible endpoint serving any model. OpenCode and Aider can drive Claude. The two axes are independent and must be configured independently.

### 2.8 Subscription quota waste is the real cost lever

The existing cost-governance model (RFC-0004) assumes pay-per-token API pricing, which is correct for direct Anthropic API calls but **wrong for the billing model most clients actually use**:

1. **Claude Code Pro/Max** allocates tokens in 5-hour rolling windows. Unused capacity at window-end is forfeit. A pipeline that processes 3 issues in a window with capacity for 8 has effectively wasted 60% of that window's value.
2. **Off-peak multiplier**: Claude Code grants approximately **2× token allocation** during documented off-peak hours. The same Opus 1M call that consumes 1 unit of quota on-peak consumes 0.5 units off-peak. A pipeline that runs all work on-peak processes half the issues per dollar of subscription compared to one that defers low-priority work to off-peak.
3. **Codex Pro / Plus** has monthly caps, not session windows. Pacing matters across the month, not within a 5-hour block.
4. **OpenRouter / generic-API** is true pay-per-token with no windows or multipliers — the legacy assumption.

The optimization problem is not "minimize cost per issue" but **"given a fixed subscription, process the maximum number of PPA-prioritized issues before the subscription period ends."** This is a knapsack/scheduling problem, and the orchestrator currently solves none of it. A pipeline that processes 12 issues per week on a $200/month subscription is twice as valuable as one that processes 6, even if the per-issue cost is identical, because the marginal subscription cost of issues 7–12 is zero.

The user-visible goal: **end every billing window having used the maximum useful share of available tokens, with the highest-PPA work front-loaded and the lowest-PPA work pushed into off-peak slots.** Idle subscription capacity is the most expensive thing in the system after a missed deadline.

### 2.9 Parallel agents corrupt each other's database state

Worktree isolation gives each parallel agent its own filesystem checkout, but every agent connects to the same `DATABASE_URL`. Three concrete failure modes follow:

1. **Test pollution.** Agent A inserts a fixture row; agent B's test asserts an empty table and fails; agent C's migration runs against rows agent A is mid-rewrite of and corrupts both.
2. **Schema race.** Agent A and agent B both add a `users.preferences` column with different types in unrelated PRs. Whichever agent runs migrations first wins; the other agent's tests pass against the "wrong" schema and the bug only surfaces in CI on main.
3. **Production data risk.** A bug in an agent's seed script (or a hallucinated `DELETE FROM`) executes against the shared dev DB, which may contain real customer data on staging or shared environments.

These are not hypothetical. Every client we have spoken to runs Postgres for their primary store, and every non-trivial pipeline includes at least one stage that writes to it. Without per-worktree DB isolation, the safe `parallelism` for these clients is **1** — defeating the entire purpose of this RFC.

The fix is well-understood: each worktree gets its own database branch (Neon, Supabase) or copy (SQLite, snapshot-restore), the agent's `DATABASE_URL` is rewritten to point at the branch, and the branch is reclaimed when the PR merges. This RFC ships the abstraction and two production-ready adapters.

## 3. Goals

- Define a `WorktreePool` resource that allocates, reuses, and reclaims worktrees across pipeline runs.
- Add a `parallelism` field to `Pipeline.spec` declaring max concurrent issues.
- Specify a deterministic port-allocation function so two agents in different worktrees never collide on dev-server ports without a central coordinator.
- Specify a merge coordination protocol that serializes the final merge gate while parallelizing all upstream stages.
- Specify an artifact directory layout (`$ARTIFACTS_DIR/<issue-id>/`) that every parallel branch writes to, enabling resumability and observability.
- Define a cross-clone worktree ownership guard.
- Add a `model` field to the Stage object so each pipeline stage declares its target model (Haiku/Sonnet/Opus/Opus 1M), with cost attribution flowing into RFC-0004's accounting per stage.
- Specify a conditional review fan-out: a Haiku-cheap classifier decides which of `{testing, critic, security}` reviewers to invoke per PR.
- Define a `harness` field on the Stage object and a HarnessAdapter interface so each stage can run on a different coding-agent runtime (Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider, generic-API).
- Specify a capability matrix that adapters MUST self-declare so the orchestrator can validate stage requirements against available harnesses at pipeline-load time.
- Specify a fallback chain so a stage can declare an ordered preference list of harnesses, falling through on rate-limit, outage, or capability mismatch.
- Define a SubscriptionLedger that tracks per-harness window state (current usage, reset time, off-peak multipliers, monthly caps) so harness/model routing and pipeline dispatch decisions consult quota in real time.
- Add a `schedule` field on the Stage object (`now` | `off-peak` | `quota-permitting` | `defer-if-low-priority`) so operators can declaratively defer cost-flexible work to high-multiplier windows.
- Specify burn-down pacing: the orchestrator MUST emit telemetry showing projected window utilization given queue depth and observed per-stage cost, so operators can intervene if the subscription is under- or over-pacing.
- Define a `DatabaseBranchAdapter` interface and `DatabaseBranchPool` resource so each worktree gets isolated database state. Ship `sqlite-copy`, `neon`, `pg-snapshot-restore`, and `external` adapters at v1.
- Define a per-stage `databaseAccess` declaration (`none` | `read` | `write` | `migrate`) so the orchestrator can decide whether to provision a branch, share a read-only one, or run migration coordination.
- Define connection-string rewriting so agents transparently see the per-worktree branch via the same env-var name (`DATABASE_URL`, etc.) the application already uses.
- Maintain backward compatibility — pipelines that omit `parallelism`, `model`, or `harness` execute serially on Claude Code with Sonnet, exactly as today.

## 4. Non-Goals

- **Non-relational stateful resources.** Redis, S3 buckets, message queues (Kafka, SQS), search indices (Elasticsearch, Algolia) — these have the same parallel-collision problem as databases but require different isolation primitives. The `DatabaseBranchAdapter` interface is deliberately scoped to relational stores; a future RFC will generalize to a `StatefulResourceAdapter` superset.
- **Distributed-transaction coordination across branches.** A pipeline that needs an agent in branch A to commit a transaction visible to an agent in branch B is out of scope. Branches are isolated by definition.
- **Branching from production data.** All DB branches in v1 derive from a designated dev/staging upstream. Branching from production carries data-handling, PII, and compliance concerns that this RFC does not address.
- **Cross-host distribution.** This RFC scopes parallelism to a single host. Multi-host execution is a future concern.
- **Dependency install caching.** `pnpm` content-addressable store is sufficient for our workloads; no special mechanism is specified here.
- **Speculative branching** (running multiple plan variants per issue and picking the winner). Out of scope.
- **Adaptive model selection.** This RFC defines *declarative* per-stage routing (the operator picks the model in YAML). Learning-based selection (the orchestrator picks the model based on stage difficulty signals) is out of scope and would be a future RFC building on the per-stage-cost telemetry this RFC requires.
- **Day-one parity across all harnesses.** This RFC defines the HarnessAdapter interface and the capability matrix. The reference implementation ships only `claude-code` (parity with today) and `codex` (highest-value second harness for cross-harness review). Adapters for `gemini-cli`, `opencode`, `aider`, and `generic-api` are deferred to follow-up work but the interface MUST be sufficient to implement them without further schema changes.
- **Cross-harness session migration.** A stage that starts on Claude Code cannot mid-flight transfer its conversation to Codex. Each stage runs end-to-end on one harness; switching happens at stage boundaries.
- **Authoritative subscription quota introspection.** Anthropic does not currently expose Claude Code window state via API. The SubscriptionLedger is a *self-tracked best-effort estimate* based on observed token consumption against documented window caps, not a queried-from-vendor source of truth. The interface is forward-compatible with an authoritative API if/when one ships.
- **Real-time spot-pricing arbitrage.** Continuously rerouting between providers on minute-by-minute price changes is out of scope. We optimize over hours-to-days windows, not seconds.
- **Billing reconciliation.** This RFC tracks consumption for *scheduling decisions*, not for accounting accuracy. Authoritative billing comes from the provider invoice. The ledger's accuracy target is "within 10% of provider-reported usage" — sufficient for pacing, insufficient for accounting.

## 5. Concepts

### 5.1 Worktree Pool

A directory (default: `~/.ai-sdlc/worktrees/<owner>/<repo>/`) containing one git worktree per active issue. Worktrees are allocated on stage entry, reused if the issue's branch matches an existing worktree, and reclaimed when the PR merges or after a stale-threshold timeout (default 14 days).

### 5.2 Worktree Ownership

A worktree's `.git` pointer file references its parent clone. The pool MUST verify the pointer matches the current clone before adopting an existing worktree, refusing to operate on worktrees from a different clone of the same upstream.

### 5.3 Deterministic Port Allocator

A pure function `port(worktreePath, basePort) → int` such that the same worktree path always receives the same port, and collision probability across N concurrent worktrees is bounded. This eliminates the need for a runtime port broker.

### 5.4 Merge Gate

A single critical section through which all PRs serialize for the rebase-and-merge step. Upstream stages (plan, build, review) run in parallel; only the final merge eligibility check and the rebase-onto-main step hold the gate.

### 5.5 Branch Artifacts

A per-issue directory (`$ARTIFACTS_DIR/<issue-id>/`) containing the plan, implementation, validation, and review outputs as durable files. Both the orchestrator and external observers (a future dashboard, the operator's `tail -f`) read from this directory.

### 5.6 Per-Stage Model

A declarative `model:` field on each Stage object, accepting one of `haiku`, `sonnet`, `opus`, `opus[1m]`, `inherit`, or an explicit model ID (`claude-haiku-4-5-20251001`). `inherit` is the default and resolves to the pipeline's `defaultModel` (today: Sonnet). The orchestrator MUST attribute token cost to the resolved model, not to `inherit`.

### 5.7 Review Classifier

A Stage with `kind: review-classifier` that consumes the PR diff and emits a structured decision listing which downstream review agents to invoke. By default it runs on Haiku. The fan-out stage downstream reads this decision and dispatches only the selected reviewers. A pipeline that omits the classifier preserves today's behavior (run all configured reviewers).

### 5.8 Harness Adapter

A pluggable runtime implementation that abstracts a coding-agent CLI behind a uniform interface. Each adapter declares its capabilities (which models it can drive, whether it supports MCP/skills/streaming/worktree-aware cwd) and translates orchestrator-level invocations (prompt, context, tools, model) into harness-native commands. Adapters are registered at orchestrator startup and resolved per-stage by name.

### 5.9 SubscriptionLedger

A per-harness state store that tracks billing-window consumption against documented quota. For Claude Code Pro/Max it tracks the rolling 5-hour window, the off-peak multiplier currently in effect, and the projected window-end utilization given queue depth. For Codex Pro it tracks the monthly cap. For pay-per-token harnesses (`generic-api`) it tracks dollar spend against the pipeline's `costBudget`. The ledger is consulted on every stage dispatch and every harness-routing decision.

### 5.10 Schedule Hint

A declarative property on a Stage indicating its temporal flexibility: `now` (must dispatch immediately), `off-peak` (defer until off-peak window if available within reasonable wait), `quota-permitting` (run if there is sufficient headroom in the current window), or `defer-if-low-priority` (PPA-conditional — defer if other higher-priority work would consume more of the current window).

### 5.11 Database Branch Adapter

A pluggable runtime implementation that abstracts a database-branching mechanism behind a uniform interface. Each adapter declares its capabilities (branch creation latency, max concurrent branches, schema-migration support, multi-database support) and translates orchestrator-level operations (allocate, snapshot-from-upstream, attach to worktree, reclaim) into provider-native API calls. Adapters are registered at orchestrator startup and resolved per-pool by name. Parallel to the HarnessAdapter pattern (§5.8) — same registry shape, same fail-fast validation, same in-tree-only security posture.

### 5.12 Database Branch

An isolated, ephemeral copy of a designated upstream database, scoped to one worktree's lifetime. The branch is created when the worktree is allocated (or lazily on first stage that declares `databaseAccess: write`), receives any pending migrations from the upstream, exposes a connection string the agent uses transparently via the same env-var name (e.g., `DATABASE_URL`) the application expects, and is destroyed when the worktree is reclaimed.

## 6. Schema Amendments

### 6.1 Pipeline.spec.parallelism (new optional field)

| Field | Type | Required | Description |
|---|---|---|---|
| `parallelism` | object | MAY | Concurrency configuration. When omitted, pipelines execute serially (current behavior). |
| `parallelism.maxConcurrent` | integer | MAY | Maximum number of issues executing concurrently. Range: 1–20. When omitted, derived from the declared SubscriptionPlan per the resolution table in §9.1. |
| `parallelism.worktreePool` | string | MAY | Reference to a `WorktreePool` resource by name. Defaults to the pipeline's name. |
| `parallelism.mergeStrategy` | string | MAY | One of `serialized-rebase` (default), `parallel-merge` (forbidden in v1, reserved). |

### 6.2 New resource: WorktreePool

```yaml
apiVersion: ai-sdlc.dev/v1alpha1
kind: WorktreePool
metadata:
  name: default-pool
spec:
  rootDir: ~/.ai-sdlc/worktrees
  layout: workspace-scoped     # or "repo-local"
  staleThresholdDays: 14
  basePort: 3190
  ownershipGuard: strict       # "strict" | "advisory"
  cleanup:
    onMerge: true
    onAbort: true
    onTimeout: true
  databaseBranchPools:         # optional, references DatabaseBranchPool resources by name (§6.7)
    - primary-postgres
    - analytics-postgres
  subscriptionPlans:           # optional, references SubscriptionPlan resources by name (§6.6)
    - claude-code-max-5x
```

### 6.3 Stage object additions (amends RFC-0002 §3)

| Field | Type | Required | Description |
|---|---|---|---|
| `isolation` | string | MAY | One of `worktree` (default when `parallelism` is set), `inplace`. Stages that must operate on the main checkout (e.g., release tagging) MUST set `inplace`. |
| `holdsMergeGate` | boolean | MAY | When `true`, this stage acquires the pipeline's merge gate for the duration of its execution. Defaults to `false`. The final merge stage MUST set this to `true`. |
| `model` | string | MAY | One of `haiku`, `sonnet`, `opus`, `opus[1m]`, `inherit`, or an explicit model ID. Defaults to `inherit`. |
| `kind` | string | MAY | One of `agent` (default), `review-classifier`, `review-fanout`. Drives stage-specific execution semantics. |
| `maxBudgetUsd` | number | MAY | Per-stage cost ceiling. When exceeded, the orchestrator MUST emit `BudgetExceeded` and apply the stage's `onFailure` policy. Hooks into RFC-0004 cost attribution. |
| `harness` | string | MAY | One of `claude-code` (default), `codex`, `gemini-cli`, `opencode`, `aider`, `generic-api`, `inherit`. Resolves against the orchestrator's adapter registry (§13.2). Pipeline-load MUST fail if an unregistered harness is named. |
| `harnessFallback` | array[string] | MAY | Ordered preference list. If the primary harness is unavailable (rate-limited, capability mismatch, runtime error during invocation), the orchestrator MUST attempt each fallback in order before applying `onFailure`. |
| `requiresIndependentHarnessFrom` | array[string] | MAY | List of upstream stage names. The orchestrator MUST exclude any harness that ran one of those upstream stages from this stage's effective `harness` + `harnessFallback` chain. See §13.10. |
| `schedule` | string | MAY | One of `now` (default), `off-peak`, `quota-permitting`, `defer-if-low-priority`. Drives subscription-aware dispatch (§14). |
| `estimatedTokens` | object | MAY | `{ input: number, output: number, frozen?: boolean }`. Operator hint used by the SubscriptionLedger for window-headroom calculations. When omitted, the orchestrator uses the cold-start default `{ input: 50000, output: 10000 }` and emits `MissingEstimate` warning. After first execution, rolling estimate from `$ARTIFACTS_DIR/_ledger/stage-estimates.json` supersedes the default UNLESS `frozen: true`, in which case the declared values are pinned and rolling updates are ignored. See §14.6 for bootstrap and freeze semantics. |
| `databaseAccess` | string | MAY | One of `none` (default), `read`, `write`, `migrate`. Drives database-branch provisioning (§15). `none` skips branch creation; `read` MAY share a single read-only branch across worktrees; `write` and `migrate` REQUIRE a per-worktree writable branch. |

### 6.4 Pipeline.spec.defaultModel (new optional field)

| Field | Type | Required | Description |
|---|---|---|---|
| `defaultModel` | string | MAY | Resolution target for any stage with `model: inherit`. Defaults to `sonnet`. Same value space as `Stage.model`. |

### 6.5 Additional Pipeline.spec fields (new optional fields)

| Field | Type | Required | Description |
|---|---|---|---|
| `defaultHarness` | string | MAY | Resolution target for any stage with `harness: inherit`. Defaults to `claude-code`. Same value space as `Stage.harness`. |
| `defaultHarnessFallback` | array[string] | MAY | Pipeline-wide default fallback chain applied to any stage that omits `harnessFallback`. |
| `tenant` | string | MAY | Tenant identifier for SubscriptionLedger keying (§14.12). When set, partitions a shared vendor account into virtual sub-windows. When omitted, all pipelines on the same `(harness, accountId)` share a single ledger. |
| `tenantQuotaShare` | number [0,1] | MAY | Fraction of the shared account's `windowQuotaTokens` allocated to this tenant. Required when `tenant` is set AND multiple tenants exist on the same `(harness, accountId)`. Sum of shares across all tenants on the same account MUST equal 1.0; validated at orchestrator startup. |
| `accountId` | string | MAY | Override for the auto-derived account identity from `HarnessAdapter.getAccountId()`. Useful when the harness can't expose a stable identity (see §14.12 ambiguous-accountId path). When set, overrides the auto-derived value and pools/isolates ledgers based on this string. |
| `offPeakMaxWait` | string | MAY | Maximum time a `schedule: off-peak` stage may wait for the next off-peak window before falling through to on-peak dispatch with `OffPeakDeferralExceeded` warning. ISO 8601 duration. Defaults to `PT8H`. |
| `artifactSchemaVersion` | string | MAY | Pin a specific artifact-schema version (e.g., `v1`, `v2`). Defaults to `v1`. Downstream stages consume artifacts at the pinned version per §16.4 schema-evolution semantics. |

### 6.6 New resource: SubscriptionPlan

Declares the billing-window characteristics of a harness so the SubscriptionLedger can pace dispatch correctly.

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
    schedule:                           # cron-style or simple time ranges
      - { tz: 'America/Los_Angeles', hours: '22-06' }
      - { tz: 'America/Los_Angeles', hours: '0-7', daysOfWeek: 'Sat,Sun' }
    lastVerified: '2026-04-15'          # operator confirmed against vendor docs on this date
  pacingTarget: 0.85                    # aim to consume 85% of window before reset
  hardCap: 0.95                         # MUST NOT dispatch new work above this fraction
  quotaSource: self-tracked             # 'self-tracked' (default) | 'authoritative-api' | 'authoritative-with-fallback'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `harness` | string | MUST | Name of the registered harness this plan applies to. |
| `billingMode` | string | MUST | One of `session-window`, `monthly-cap`, `pay-per-token`. |
| `windowDuration` | string | when `session-window` | ISO 8601 duration of the rolling window. |
| `windowQuotaTokens` | integer | when `session-window` or `monthly-cap` | Documented quota per window. |
| `offPeak` | object | MAY | Multiplier configuration. Absent → no off-peak preference. |
| `pacingTarget` | number [0,1] | MAY | Burn-down target. Defaults to `0.80`. |
| `hardCap` | number [0,1] | MAY | Above this fraction of window quota, the orchestrator MUST NOT dispatch new work even if a stage has `schedule: now`. Defaults to `0.95`. |
| `quotaSource` | string | MAY | Source of authoritative window state. Defaults to `self-tracked`. See §14.11 for migration semantics. |

`SubscriptionPlan` is referenced by `WorktreePool.spec.subscriptionPlans[]` (or pipeline-scoped). Multiple plans MAY exist per harness when an account has multiple seats; the orchestrator distributes work across them.

### 6.7 New resource: DatabaseBranchPool

Declares a pool of database branches available for per-worktree allocation. Multiple pools MAY exist per pipeline when an application uses multiple databases (e.g., primary Postgres + analytics Postgres + Redis-replacement KeyDB).

```yaml
apiVersion: ai-sdlc.dev/v1alpha1
kind: DatabaseBranchPool
metadata:
  name: primary-postgres
spec:
  adapter: neon                         # 'neon' | 'sqlite-copy' | 'pg-snapshot-restore' | 'supabase' | 'external'
  upstream:
    connectionStringEnv: DATABASE_URL_DEV   # env var the orchestrator reads to find upstream
    branchFrom: dev                          # named upstream branch (Neon) or 'main' for snapshot-restore
  injection:
    targetEnv: DATABASE_URL                  # env var rewritten in agent invocation
    additionalEnvs: [PGHOST, PGDATABASE]     # optional, parsed from connection string
  lifecycle:
    createOn: worktree-allocation            # 'worktree-allocation' | 'first-write-stage'
    reclaimOn: pr-merge                      # 'pr-merge' | 'worktree-reclaim' | 'manual'
    maxConcurrent: 10
    branchTtl: P14D
    abandonAfter: P7D                        # destroy if no activity, even before TTL
    warmPoolSize: 0                          # pre-allocated branches; 0 = on-demand only (default)
  migrations:
    runOnBranchCreate: true
    migrationCommand: 'pnpm db:migrate'      # how to apply pending migrations to a fresh branch
    migrationCwd: orchestrator               # relative to worktree root
  credentials:
    apiTokenEnv: NEON_API_TOKEN              # adapter-specific; see §15.3
    projectId: prj_abc123                    # Neon project ID
```

| Field | Type | Required | Description |
|---|---|---|---|
| `adapter` | string | MUST | Name of a registered DatabaseBranchAdapter. Pipeline-load fails on unknown adapter. |
| `upstream` | object | MUST | Source database to branch from. |
| `upstream.connectionStringEnv` | string | MUST | Env var name the orchestrator reads at startup to discover upstream. The connection string itself is NEVER logged or persisted. |
| `upstream.branchFrom` | string | adapter-dependent | Named upstream branch (Neon, Supabase) or upstream identifier for snapshot-restore. By default MUST reference a stable, non-PR-feature upstream (e.g., `dev`, `main`). See `allowBranchFromBranch` below. |
| `allowBranchFromBranch` | boolean | MAY | Defaults to `false`. When `false`, the adapter MUST refuse to allocate a branch whose upstream is itself an in-flight feature branch — pipeline-load fails with `BranchTopologyForbidden`. When `true`, operator opts into branch-from-branch chains and accepts `MigrationDiverged` events on parent reclaim (§15.5.1). |
| `injection` | object | MUST | How the branch's connection string is exposed to agents. |
| `injection.targetEnv` | string | MUST | Env var name rewritten in the agent's environment. |
| `injection.additionalEnvs` | array[string] | MAY | Additional env vars to derive (host, port, database, user) from the rewritten connection string. |
| `lifecycle` | object | MAY | Branch lifecycle configuration. |
| `lifecycle.createOn` | string | MAY | When to provision the branch. `worktree-allocation` (default) creates eagerly; `first-write-stage` creates lazily and is cheaper if many runs only have read stages. |
| `lifecycle.reclaimOn` | string | MAY | When to destroy the branch. Defaults to `pr-merge`. |
| `lifecycle.maxConcurrent` | integer | MAY | Cap on concurrent branches. MUST NOT exceed the adapter's declared `maxBranches` capability. Defaults to the resolved `Pipeline.spec.parallelism.maxConcurrent` of the pipeline that owns the WorktreePool. |
| `lifecycle.branchTtl` | string | MAY | ISO 8601 max branch age. Branches older than TTL are reclaimed regardless of activity. |
| `lifecycle.abandonAfter` | string | MAY | ISO 8601 idle threshold. Defaults to `P7D`. |
| `lifecycle.warmPoolSize` | integer [0,20] | MAY | Pre-allocated branch count. Defaults to `0` (on-demand allocation). When > 0, see §15.4.1 for warm-pool semantics. |
| `migrations` | object | MAY | Migration coordination. |
| `migrations.runOnBranchCreate` | boolean | MAY | Run pending migrations against the branch immediately on creation. Defaults to `true`. |
| `migrations.migrationCommand` | string | when `runOnBranchCreate: true` | Shell command executed inside the worktree, with the branch's connection string injected. |
| `migrations.migrationCwd` | string | MAY | Subdirectory relative to worktree root. Defaults to worktree root. |
| `credentials` | object | adapter-dependent | Adapter-specific configuration. See §15.3. |

## 7. Worktree Pool Manager

### 7.1 Allocation algorithm

On stage entry with `isolation: worktree`:

1. Compute the issue's branch name from `Pipeline.spec.branching.pattern` (existing behavior).
2. Search the pool for an existing worktree whose checked-out branch equals the computed name.
3. If found and `verifyOwnership()` passes → adopt and return.
4. If found and ownership fails → refuse with error `WorktreeOwnershipMismatch`. Operator intervention required.
5. If not found → run `git worktree add <pool>/<branch-slug> -b <branch> origin/<targetBranch>` and return.

### 7.2 Ownership verification

```
verifyOwnership(worktreePath, currentRepoPath):
  pointer = read("$worktreePath/.git")        # ".git: <path>" file
  declaredGitDir = parse(pointer)
  return realpath(declaredGitDir).startsWith(realpath("$currentRepoPath/.git/worktrees/"))
```

Implementations MUST refuse to operate on worktrees that fail ownership verification when `WorktreePool.spec.ownershipGuard: strict`.

### 7.3 Reclamation

A worktree is eligible for reclamation when:

- The PR for its branch has merged (and `cleanup.onMerge: true`), OR
- The pipeline run aborted (and `cleanup.onAbort: true`), OR
- The worktree's mtime is older than `staleThresholdDays` and no active pipeline run references it.

Reclamation MUST be guarded by an uncommitted-changes check. Reclaiming a worktree with uncommitted changes is a destructive operation and MUST require operator confirmation, regardless of pool configuration.

### 7.4 Slug normalization

Branch names like `feat/issue-42` MUST be slugified to `feat-issue-42` for the on-disk worktree directory name. The orchestrator MUST be able to round-trip from branch → slug → worktree path.

## 8. Deterministic Port Allocator

### 8.1 Function

```
port(worktreePath, basePort = 3190):
  digest = md5(absolute(worktreePath))
  offset = (digest[0] << 8 | digest[1]) % 900 + 100
  return basePort + offset
```

This produces ports in `[basePort + 100, basePort + 999]` (default `3290–4189`). Same worktree path → same port, with no central coordinator.

### 8.2 Collision handling

The function's range (900 ports) bounds expected collisions. With the default `WorktreePool.spec` cap of `maxConcurrent: 10`, the birthday-paradox collision probability is < 6%. On collision, the orchestrator MUST log a `PortCollision` warning and probe the next ten consecutive ports for a free one. The probed port is recorded in `$ARTIFACTS_DIR/<issue-id>/runtime.json` so subsequent stages within the same run reuse it.

### 8.3 Override

An explicit `PORT` environment variable in the agent's invocation environment MUST take precedence over the computed port. This preserves operator control for debugging.

### 8.4 Multi-port services

When a stage requires more than one port (e.g., dev server + websocket), the additional ports are allocated as `port + 1`, `port + 2`, ... up to a maximum of 10 contiguous ports. Stages requiring more contiguous ports MUST declare a custom allocation strategy (out of scope for v1).

## 9. Concurrency and Admission Control

### 9.1 Global cap

The orchestrator MUST NOT execute more than the resolved `maxConcurrent` value simultaneously. Excess issues queue in PPA-priority order (RFC-0008) and dispatch as slots free.

**Resolution algorithm.** When `Pipeline.spec.parallelism.maxConcurrent` is omitted, the orchestrator resolves it in this order:

1. Explicit `Pipeline.spec.parallelism.maxConcurrent` (if present).
2. Tier-aware default derived from any `SubscriptionPlan` referenced by the pipeline's harness:

| Declared SubscriptionPlan | Default `maxConcurrent` | Rationale |
|---|---|---|
| (none declared) | `1` | Backward-compatible with today's behavior; no surprise regressions on plugin upgrade. |
| `claude-code-pro` | `3` | Pro tier quota sustains ~3 concurrent Opus stages over a 5h window without exhausting hardCap. |
| `claude-code-max-5x` | `5` | 5× quota → 5 concurrent stages without burndown alarm. |
| `claude-code-max-20x` | `10` | 20× quota leaves headroom for the 10-cap ceiling we set in §6.1. |
| `codex-plus` | `2` | Lower monthly cap; conservative default. |
| `codex-pro` | `5` | Comparable to Max-5x. |
| `pay-per-token` | `5` | No quota constraint; cap chosen for host-resource sanity. |
| Multiple plans for the same harness | `sum(per-plan default)` | Operator with multiple seats gets additive headroom. |
| Multiple harnesses across stages | `max(per-harness default)` | The dispatcher caps total in-flight; per-harness contention is surfaced via the `QuotaContention` event for the operator to size separately. |

3. Hard floor `1`, hard ceiling `20`. Resolved value is clamped to this range and logged as `ResolvedParallelism` at pipeline-load time.

The resolution is computed once at pipeline-load and recorded in `$ARTIFACTS_DIR/_pipeline/runtime.json`. Subscribing a SubscriptionPlan after pipeline-load does NOT change the resolved cap until the pipeline is reloaded — operators MUST restart the pipeline run to pick up a new tier.

**Why couple parallelism to SubscriptionPlan declaration.** Declaring a SubscriptionPlan is itself the operator signaling "I care about subscription utilization." It is the right opt-in trigger for parallelism — clients who never declare a plan get safe serial behavior; clients who declare a plan get parallelism appropriate to their quota. This avoids both the "ship 5 by default and surprise everyone" failure mode and the "ship 1 by default and underuse every subscription" failure mode.

### 9.2 Admission

A new issue is admitted to execution when:

- A worktree pool slot is available, AND
- The issue's PPA admission composite (RFC-0008 §A.6) meets the configured threshold, AND
- The merge gate is not held (or this stage does not require the gate), AND
- Cost governance budget headroom exists (RFC-0004).

### 9.3 Backpressure

If admission fails for any reason other than capacity, the orchestrator MUST emit a `Delayed Requeue` (RFC-0002 reconciliation semantics) rather than busy-waiting.

### 9.4 Re-scoring on requeue

When an issue's stage fails and is requeued for retry, the orchestrator MUST decide whether to trust the original PPA admission composite (RFC-0008 §A.6) or re-run it against the latest signals before placing the issue back on the queue. The decision balances re-triage cost (one Haiku call, ~$0.001) against the risk of dispatching stale priority.

**Decision algorithm.** Re-score IF ANY of:

1. **Time threshold**: more than 24 hours have elapsed since the last triage event recorded in `$ARTIFACTS_DIR/<issue-id>/triage-history.jsonl`.
2. **Failure-type signal**: the failure that triggered the requeue indicates the issue is harder than the original triage estimated. See §9.4.1 taxonomy.
3. **Operator-triggered requeue**: a human reached for the requeue button (e.g., `cli-requeue <issue>` or PR comment trigger). The act of manual requeue is itself a signal that priority should be refreshed.

ELSE trust the original score and requeue without re-triage. The orchestrator MUST emit a structured `Requeue` event naming whether re-scoring happened and why ("re-scored: time threshold exceeded" vs "trusted score: transient failure within 24h").

#### 9.4.1 Failure-type taxonomy

| Failure event | Class | Re-score on first occurrence? | Re-score after Nth occurrence? |
|---|---|---|---|
| `MergeConflict` | Transient (base moved) | No | No (still transient regardless of count) |
| `RebaseConflict` | Transient (base moved) | No | No |
| `CIFailure` | Transient (flaky tests, infra) | No | After 3rd: Yes (signals real bug, not flake) |
| `HarnessUnavailable` | External (vendor outage) | No | No |
| `BranchQuotaExceeded` | External (infra cap) | No | No |
| `PortCollision` | External (local race) | No | No |
| `BudgetExceeded` | Mixed | No | After 2nd: Yes (consistent under-estimate signals miscalibration) |
| `OffPeakDeferralExceeded` | External (timing) | No | No |
| `AgentTimeout` | Intrinsic (task harder than estimated) | No | After 2nd: Yes |
| `MaxRetriesExhausted` | Intrinsic (persistent failure) | Yes | Yes |
| `MigrationConflict` | Intrinsic (schema entanglement) | Yes | Yes |
| `MigrationFailed` | Intrinsic (approach mismatch) | Yes | Yes |
| `EstimateVariance` (persistent flag) | Intrinsic (calibration drift) | Yes | Yes |
| `WorktreeOwnershipMismatch` | External (operator config) | No | No |

Counts are tracked per-issue in `triage-history.jsonl`. Reset to zero on successful merge.

**Failure-event semantics** (referenced in the table above; mostly inherited from RFC-0002 reconciliation semantics with this RFC's additions):

- `MergeConflict` — git merge conflict during the merge gate's rebase step (§10.2).
- `RebaseConflict` — `git rebase origin/<targetBranch>` failed mid-stage (§10.2).
- `CIFailure` — CI checks reported failure on the PR (per `feedback_review_severity_policy.md`).
- `AgentTimeout` — stage execution exceeded its `timeout` (RFC-0002 §3) without producing a final artifact.
- `MaxRetriesExhausted` — RFC-0002 `onFailure: retry` reached `maxRetries` without success.
- `BudgetExceeded`, `BranchQuotaExceeded`, `HarnessUnavailable`, `WorktreeOwnershipMismatch`, `OffPeakDeferralExceeded`, `MigrationConflict`, `MigrationFailed`, `EstimateVariance`, `PortCollision` — defined in their respective sections (§14.x, §15.x, §13.x, §7.2, §8.2).

#### 9.4.2 Triage history

Every triage event (original + every re-score) is appended to `$ARTIFACTS_DIR/<issue-id>/triage-history.jsonl`:

```json
{
  "timestamp": "2026-04-26T14:32:11Z",
  "trigger": "original" | "time-threshold" | "failure-type" | "operator-requeue",
  "triggerDetail": "AgentTimeout x2",
  "score": { "Sα": 0.72, "Dπ": 0.55, "Eρ": 0.40, "HC": 0.85, "composite": 0.61 },
  "deltaFromPrevious": { "composite": -0.14, "narrative": "Eρ dropped: agent timeouts indicate harder than estimated" },
  "model": "claude-haiku-4-5-20251001",
  "costUsd": 0.0011
}
```

The `deltaFromPrevious` field surfaces score drift over time, which feeds the calibration analysis in the burn-down report (§14.4) — persistent under-estimation of difficulty across many issues signals the PPA scoring rubric itself needs adjustment.

#### 9.4.3 Cost accounting

Re-triage Haiku calls accumulate against the same `costBudget` and SubscriptionLedger as any other stage (§11.5). At ~$0.001 per re-triage, the cost is rounding error for normal pipelines but MAY become significant on a pipeline experiencing pathological retry storms — the orchestrator MUST emit a `RetriageStorm` warning if any single issue triggers more than 10 re-triage events within a 24h window, signaling the failure is not actually being addressed.

#### 9.4.4 Queue ordering on re-score

When a re-score changes an issue's composite, the orchestrator MUST re-insert the issue into the queue at its new priority position, not its original. Operators MAY observe the queue order shifting underneath them; the `Requeue` event includes the old and new queue positions for debuggability.

## 10. Merge Coordination

### 10.1 The merge gate

The pipeline run holds a single mutex (`<pool>/.merge-gate.lock`). A stage with `holdsMergeGate: true` acquires the lock on entry, performs its work (rebase + merge eligibility check + push), and releases on exit.

### 10.2 Stale-base detection

Before holding the merge gate, the pipeline run MUST verify the PR's base commit equals `origin/<targetBranch>@HEAD`. If stale:

1. Acquire the merge gate.
2. Run `git fetch origin && git rebase origin/<targetBranch>` inside the issue's worktree.
3. On clean rebase → `git push --force-with-lease origin <branch>` and re-run the merge eligibility check.
4. On rebase conflict → emit a `RebaseConflict` event, transition the pipeline run to `Suspended`, release the gate. Operator intervention required.

### 10.3 No automatic merge

Per the project governance constraint (`feedback_never_merge_prs.md`): the orchestrator MUST NOT execute `gh pr merge`. The merge gate's purpose is to ensure that when the human reviewer clicks merge, the PR is in a known-mergeable state, not to perform the merge itself.

## 11. Per-Stage Model Routing

### 11.1 Resolution

At **pipeline-load** (not stage entry), the orchestrator resolves every stage's alias to a physical model ID in this order:

1. Explicit `Stage.model` (if not `inherit`).
2. `Pipeline.spec.defaultModel`.
3. The orchestrator's hardcoded default (`sonnet`).

The resolved physical IDs are written to `$ARTIFACTS_DIR/_pipeline/runtime.json` and pinned for the lifetime of the pipeline run. Stages dispatched within the run use the pinned ID, regardless of registry changes between dispatch events. Per-issue runtime.json (§16.1) records the same resolution for the issue's stages.

**Why pin at pipeline-load.** Resolving on every stage entry would let the model swap underneath a running pipeline if the registry is updated mid-run (e.g., maintainer pushes a model-deprecation update). Pinning eliminates within-run inconsistency. New pipeline runs (started after the registry change) pick up the new resolution; in-flight runs complete on the model they started with.

Mid-stage model changes are NOT supported.

### 11.2 Model alias table

| Alias | Resolves to | `deprecatedAt` | `removedAt` | Use case |
|---|---|---|---|---|
| `haiku` | `claude-haiku-4-5-20251001` | null | null | Classification, routing, formatting, structured-output extraction |
| `sonnet` | `claude-sonnet-4-6` | null | null | Code review, refactoring, validation, default for everything else |
| `opus` | `claude-opus-4-7` | null | null | Complex implementation, multi-file refactors, design work |
| `opus[1m]` | `claude-opus-4-7[1m]` | null | null | Implementation against a large codebase context (>200K tokens) |

Aliases are resolved at pipeline-load against a registry file (`orchestrator/src/models/registry.ts`). The two date columns drive the deprecation lifecycle defined in §11.6. Maintainer responsibility: keep both dates current as vendors publish deprecation announcements.

### 11.3 Recommended routing for the dogfood pipeline

Non-normative guidance the reference implementation SHOULD ship as defaults. Harness defaults to `claude-code` unless cross-harness independence adds review value or cost arbitrage is meaningful:

| Stage | Model | Harness | Rationale |
|---|---|---|---|
| `triage` (PPA scoring) | `haiku` | `claude-code` | Pattern matching against fixed scoring rubric |
| `review-classify` | `haiku` | `claude-code` | Diff-shape classification |
| `plan` | `sonnet` | `claude-code` | Default-balance, uses our skills/MCP tools |
| `implement` | `opus[1m]` | `claude-code` | Large-context multi-file edits, full skill ecosystem |
| `validate` | `sonnet` | `claude-code` | Test execution + log interpretation |
| `review-testing` | `sonnet` | `claude-code` | Same harness as implementer is acceptable for testing review |
| `review-critic` | `sonnet` | `codex` | **Cross-harness review** — different model family catches different bugs |
| `review-security` | `sonnet` | `codex` | **Cross-harness review** — independence is a security property |
| `fix-pr` | `sonnet` | `claude-code` | Most fix actions are mechanical |
| `simplify` | `sonnet` | `claude-code` | Localized refactor |

### 11.4 Cost attribution (amends RFC-0004 §4)

Per-stage cost reporting MUST include the resolved model ID, not the alias. The cost-governance ledger (`orchestrator/src/cost-governance.ts`) gains a `modelId` column; aggregation queries SHOULD support grouping by alias, model ID, and stage. This is a strict superset of RFC-0004's existing reporting and is therefore backward compatible.

### 11.5 Token budget interaction

The orchestrator enforces three independent caps with distinct scopes and units. Confusing them is a common source of operator surprise; this section pins them down.

| Cap | Defined in | Unit | Scope | Aggregation across parallel agents |
|---|---|---|---|---|
| `Pipeline.spec.costBudget` | RFC-0004 | USD (or pipeline currency) | Pipeline (all parallel agents) | **Shared** — sum across agents MUST NOT exceed |
| `SubscriptionPlan.windowQuotaTokens` | §6.6 | tokens, multiplier-adjusted | Per-harness, per-window | **Per-harness** — agents on the same harness share; agents on different harnesses are independent |
| `Stage.maxBudgetUsd` | §6.3 | USD per single stage invocation | Per-stage, per-invocation | Independent — circuit breaker, never aggregated |

**Admission rule.** A stage admits only if ALL of:
1. Adding its `estimatedTokens × resolvedModel.unitCost` to current pipeline-shared spend keeps total ≤ `costBudget`.
2. The stage's harness has subscription headroom per `ledger.admit()` (§14.2), OR the harness is `pay-per-token` (no quota).
3. The stage's `estimatedTokens × resolvedModel.unitCost` ≤ its own `maxBudgetUsd` (if declared).

Failure of any check blocks admission. The orchestrator emits a structured `AdmissionDenied` event naming which cap blocked, so operators can tell "blocked on dollars" from "blocked on subscription window" from "blocked on per-stage circuit breaker."

**Why three caps, not one.** Dollar budgets are a Finance concern (don't overspend the month). Subscription windows are a vendor-imposed reality (don't exhaust Claude Code's 5h quota). Per-stage circuit breakers are a runaway-protection concern (kill a stage that 10×'d its estimate). Each has a different audience, a different unit, and a different correct response when breached. Conflating them produces confusing operator behavior — operators set "$50/day" and then can't understand why dispatch blocks when only $12 has been spent (answer: subscription window exhausted, unrelated to dollars).

### 11.6 Model deprecation lifecycle

The model registry tracks each entry's `deprecatedAt: Date | null` and `removedAt: Date | null`. Resolution behavior at pipeline-load:

| Registry state at load time | Behavior |
|---|---|
| Both null (active) | Resolve normally. No warning. |
| `deprecatedAt < now`, `removedAt > now` (or null) | Resolve normally. Emit `ModelDeprecated` warning naming `removedAt` and the recommended replacement alias. |
| `removedAt < now` (removed) | Pipeline-load FAILS with `ModelRemoved`. Operator MUST update the pipeline YAML, the registry, or both before the run can start. |
| `deprecatedAt < now < deprecatedAt + 30 days` (grace period) | Resolve normally + emit warning, AND emit a one-time `ModelDeprecationGracePeriod` event to the pipeline's primary observability channel (e.g., Slack per `project_slack_integration.md`) so the operator sees it even if they don't read pipeline-load logs. |

**Replacement recommendation.** When a registry entry is `deprecatedAt`, it MUST also declare `replacementAlias: string` pointing at the alias operators should bump to. The warning message includes this so the operator knows the migration target without consulting docs.

**Operator workflow.** The reference implementation SHOULD ship `cli-model-bump`:

```
$ cli-model-bump --dry-run
Pipeline `dogfood`:
  Stage `triage` (model: haiku) currently resolves to claude-haiku-4-5-20251001
    DEPRECATED 2026-08-01, REMOVED 2027-02-01
    Replacement: claude-haiku-5-0-20270115 (via alias `haiku`)
  Run without --dry-run to start a new pipeline run that picks up the replacement.
```

The dry-run exists so operators can preview a model swap in a non-production pipeline before letting it land in their default flow. There is intentionally no in-place model-swap on a running pipeline — pinning at pipeline-load is the safety property; bypassing it would defeat the purpose.

**Registry maintenance.** Maintainers update `deprecatedAt` / `removedAt` / `replacementAlias` in `orchestrator/src/models/registry.ts` from public vendor announcements. A periodic registry-freshness check (Phase 4 observability) compares the registry's listed dates against vendor public-docs URLs and warns on stale entries (default: warn if any non-null `deprecatedAt` is more than 60 days old without `removedAt` being scheduled).

**Mid-flight protection.** Because resolution is pinned at pipeline-load (§11.1), a pipeline run that started before a model was deprecated continues to use the deprecated physical ID until completion. The vendor's actual API may continue to accept the deprecated ID for a vendor-defined sunset window after `removedAt` — the orchestrator will not emit new requests against a removed alias for new runs, but in-flight runs use what they pinned. If the vendor returns a hard error mid-run, the request fails per the harness's normal error handling (§13.5 fallback chain).

## 12. Conditional Review Fan-Out

### 12.1 Stage kinds

This RFC introduces two new stage kinds (declared via the `kind` field added in §6.3):

- **`review-classifier`** — Consumes the PR diff (via `gh pr diff`) and emits a structured decision document at `$ARTIFACTS_DIR/<issue-id>/review/classifier.json`.
- **`review-fanout`** — Reads `classifier.json` and dispatches the selected reviewer agents in parallel.

A pipeline that omits the classifier and uses ordinary review stages preserves today's behavior.

### 12.2 Classifier output schema

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["reviewers", "rationale", "confident", "confidence"],
  "properties": {
    "reviewers": {
      "type": "array",
      "items": { "enum": ["testing", "critic", "security"] },
      "uniqueItems": true
    },
    "rationale": {
      "type": "object",
      "additionalProperties": { "type": "string" },
      "description": "Map of reviewer name to one-sentence reason for inclusion or exclusion."
    },
    "confident": {
      "type": "boolean",
      "description": "Drives dispatch. When false, the orchestrator falls open to the full reviewer set regardless of `reviewers`."
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Informational self-assessment. Fed to calibration analysis at $ARTIFACTS_DIR/_classifier/calibration.jsonl. NOT consulted by the dispatcher."
    },
    "modelOverride": {
      "type": "object",
      "additionalProperties": {
        "enum": ["haiku", "sonnet", "opus", "opus[1m]"]
      },
      "description": "Optional per-reviewer model bump (e.g., security-flagged diff escalates security-reviewer to opus)."
    },
    "harnessOverride": {
      "type": "object",
      "additionalProperties": {
        "enum": ["claude-code", "codex", "gemini-cli", "opencode", "aider", "generic-api"]
      },
      "description": "Optional per-reviewer harness override (e.g., a security-flagged diff routes security-reviewer to a specific harness for cross-harness independence per §13.6 / §13.10)."
    }
  },
  "allOf": [
    {
      "description": "Consistency: confident: true REQUIRES confidence >= 0.7. Validation failure triggers fall-open.",
      "if": { "properties": { "confident": { "const": true } } },
      "then": { "properties": { "confidence": { "minimum": 0.7 } } }
    }
  ]
}
```

### 12.3 Default classifier rules

The reference implementation SHOULD ship a Haiku classifier with these baseline rules (operators MAY override):

| Diff signal | Default reviewer set |
|---|---|
| Only `*.md`, `docs/**` | `[critic]` |
| Only formatting / whitespace | `[]` (skip review entirely; classifier MAY emit empty set) |
| Touches `src/**/*.{ts,js,py}` without tests | `[testing, critic]` |
| Touches `src/**/*.{ts,js,py}` with tests | `[testing, critic]` |
| Touches `auth/**`, `crypto/**`, secrets, config that affects auth | `[testing, critic, security]` |
| Touches `package.json` / `requirements.txt` / lockfiles | `[security, critic]` (supply-chain) |
| Touches CI workflows (`.github/workflows/**`) | `[security, critic]` |
| Default fallback | `[testing, critic, security]` (today's behavior) |

**Fall-open triggers.** The orchestrator MUST dispatch the full reviewer set (`[testing, critic, security]`) regardless of `reviewers` when ANY of:

1. JSON parse error in classifier output.
2. Schema validation failure (missing required field, type mismatch, or `confident: true` with `confidence < 0.7`).
3. `confident: false`.
4. Classifier invocation failed (timeout, harness unavailable, exhausted fallback chain).

**Failing open is a non-negotiable safety property** — the cost of an unneeded reviewer run is far less than the cost of a missed security finding.

**Calibration log.** Every classifier output (whether trusted or fallen-open) is appended to `$ARTIFACTS_DIR/_classifier/calibration.jsonl`:

```json
{
  "timestamp": "2026-04-26T14:32:11Z",
  "issueId": "AISDLC-247",
  "diffStats": { "filesChanged": 3, "linesAdded": 47, "linesRemoved": 12, "paths": ["src/auth/", "src/auth.test.ts"] },
  "classifierOutput": { "reviewers": ["testing", "critic", "security"], "confident": true, "confidence": 0.91, "rationale": {...} },
  "fellOpen": false,
  "fellOpenReason": null,
  "humanOverrideAfterMerge": null
}
```

The `humanOverrideAfterMerge` field is back-filled later if a human reviewer added a missing reviewer to the PR after merge or flagged a finding that the skipped reviewer would have caught — the operator runs `cli-classifier-feedback <pr-number> --add-reviewer security --reason "missed XSS"` to attribute the miss back to a classifier output. This is the calibration ground truth.

**Why both `confident` and `confidence`.** The dispatch decision is binary — either run security review or don't. But the float `confidence` lets us audit calibration: if the classifier consistently outputs `confident: true` at `confidence: 0.72` for PRs that turn out to need additional review (per `humanOverrideAfterMerge`), the prompt is overconfident and the operator MAY tighten the consistency threshold (e.g., require `confidence ≥ 0.85` for `confident: true`) or rewrite the prompt. Without the float we cannot detect this.

### 12.4 Review-policy compatibility

The merge-readiness rules from `feedback_review_severity_policy.md` (merge on APPROVE with suggestions; only block on REQUEST_CHANGES with critical/major) MUST continue to apply unchanged. A reduced reviewer set means fewer reviewers can post `REQUEST_CHANGES`; it does not change how the orchestrator interprets what they post.

### 12.5 Audit trail

`classifier.json` is part of the per-issue artifact directory and is preserved alongside the review outputs. Operators can audit *why* a given PR ran a reduced reviewer set and tune the classifier rules accordingly. This feeds the self-healing layer described in `feedback_observability.md`.

## 13. Harness Selection

### 13.1 HarnessAdapter interface

Every harness adapter MUST implement the following TypeScript interface (declared at `orchestrator/src/harness/types.ts`):

```typescript
interface HarnessAdapter {
  readonly name: string;                        // 'claude-code', 'codex', etc.
  readonly capabilities: HarnessCapabilities;
  readonly requires: HarnessRequires;           // §13.8 binary + version range

  // Validate at pipeline-load time, before any execution.
  validate(stage: ResolvedStage): ValidationResult;

  // Execute one stage end-to-end. Streams progress via onEvent.
  invoke(input: HarnessInput, onEvent: (e: HarnessEvent) => void): Promise<HarnessResult>;

  // List models the harness can drive (after env-var introspection).
  availableModels(): Promise<string[]>;

  // Cheap liveness probe used by the fallback chain.
  // Combines binary presence + version-range check + adapter-specific health probe.
  // Result MAY be cached for the orchestrator's lifetime; operator restart picks up
  // a freshly-installed binary.
  isAvailable(): Promise<HarnessAvailability>;

  // Stable identifier for the credential / account in scope. Used as the
  // SubscriptionLedger key so two pipelines on the same vendor account auto-pool.
  // MUST be a one-way derivation (e.g., SHA-256 of the API key + harness name)
  // and MUST NOT leak the credential itself. Returns null when the harness
  // cannot derive an account identity (e.g., generic-api with no auth scheme),
  // in which case the orchestrator emits LedgerKeyAmbiguous and degrades to
  // per-pipeline ledger keying.
  getAccountId(): Promise<string | null>;
}

interface HarnessCapabilities {
  freshContext: boolean;        // Can spawn a clean session per invocation
  customTools: boolean;         // Supports MCP tools / custom tool definitions
  streaming: boolean;           // Emits incremental output (for heartbeats)
  worktreeAwareCwd: boolean;    // Honors a per-invocation cwd
  skills: boolean;              // Supports loadable skills/system prompts
  artifactWrites: boolean;      // Can write files to $ARTIFACTS_DIR mid-stage
  maxContextTokens: number;     // Largest context window across this harness's models
}

interface HarnessRequires {
  binary: string;               // Executable name resolved against PATH ('claude', 'codex', etc.)
  versionRange: string;         // semver range ('>=2.0.0'). Open-ended upper bound by default.
  versionProbe: {
    args: string[];             // e.g., ['--version']
    parse: (stdout: string) => string;  // extracts a semver-shaped version string
  };
}

interface HarnessAvailability {
  available: boolean;
  reason?: 'binary-missing' | 'version-out-of-range' | 'probe-failed' | 'health-check-failed';
  detail?: string;              // operator-facing message naming installed version + required range
  installedVersion?: string;
}

interface HarnessInput {
  prompt: string;
  cwd: string;                  // Worktree path
  model: string;                // Resolved model ID (not alias)
  port?: number;                // Allocated dev-server port
  artifactsDir: string;
  tools?: ToolDefinition[];
  skills?: string[];
  timeout?: string;             // ISO 8601 duration
  maxBudgetUsd?: number;
}

interface HarnessResult {
  status: 'success' | 'failure' | 'timeout' | 'budget-exceeded' | 'unavailable';
  exitCode: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  artifactPaths: string[];      // Files the harness wrote
  errorDetail?: string;
}
```

### 13.2 Adapter registry

The orchestrator maintains a registry at `orchestrator/src/harness/registry.ts`:

```typescript
const HARNESSES = new Map<string, HarnessAdapter>([
  ['claude-code', new ClaudeCodeAdapter()],
  ['codex',       new CodexAdapter()],
  // 'gemini-cli', 'opencode', 'aider', 'generic-api' — registered when adapters land
]);
```

Pipeline-load MUST fail with `UnknownHarness` if a stage names a harness not present in the registry. This is fail-fast by design — silent fallback to a different harness would obscure operator intent.

### 13.3 Capability matrix (initial adapters)

The reference implementation ships these two adapters at v1; the matrix below is the starting baseline and MUST be kept current as adapters evolve.

| Capability | `claude-code` | `codex` | `gemini-cli` (future) | `opencode` (future) | `aider` (future) | `generic-api` (future) |
|---|---|---|---|---|---|---|
| freshContext | ✅ | ✅ | ✅ | ✅ | ⚠️ stateful | ✅ |
| customTools (MCP) | ✅ | ⚠️ partial | ❌ | ✅ | ❌ | ❌ |
| streaming | ✅ | ✅ | ✅ | ✅ | ✅ | depends |
| worktreeAwareCwd | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| skills | ✅ | ❌ | ❌ | ⚠️ partial | ❌ | ❌ |
| artifactWrites | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ via tools only |
| maxContextTokens | 1M (Opus) | 200K (GPT-5) | 2M (Gemini) | varies | varies | depends |

The matrix is normative: stage validation (§13.4) checks declared requirements against this table.

### 13.4 Validation

At pipeline-load time, for each stage:

1. Resolve `harness` and `harnessFallback` against the registry.
2. Call `adapter.isAvailable()` for the primary and every fallback. This runs the version probe (§13.8). If `available: false` for the primary, pipeline-load FAILS with `HarnessUnavailable` naming the `reason` and `detail` (e.g., "claude 1.8.2 installed, adapter requires >=2.0.0"). Fallbacks that report unavailable are removed from the chain with a warning, not a hard fail (pipeline can still start with a degraded fallback chain).
3. Resolve `model` against the harness's `availableModels()`.
4. Verify the stage's declared requirements (e.g., `requires: [skills, customTools]` on the Stage object) are satisfied by the harness's static `capabilities`.
5. Verify the same for every remaining fallback harness — a fallback that cannot satisfy the stage's requirements MUST be removed from the chain (warning), not abort pipeline-load.

A failed validation on the primary harness is a pipeline-load error. The pipeline does not start. Failures on fallbacks degrade the fallback chain but allow the pipeline to start, with a warning naming each disabled fallback.

**Why static capabilities are authoritative.** The probe at step 2 confirms the binary's *version* is in range; it does not re-derive the *capability matrix*. Capabilities are whatever the adapter source declares for that version range. This gives operators a single, deterministic source of truth (the adapter source) for "what does this harness do," without parsing fragile CLI feature flags. The probe's job is only to confirm the installed binary is the one the static declaration was written against.

### 13.5 Fallback semantics

When a stage executes:

1. Probe `primary.isAvailable()`. If true, attempt `invoke()`.
2. On `result.status === 'unavailable'` OR rate-limit error during invocation, the orchestrator MUST log a `HarnessFallback` event and proceed to the next harness in `harnessFallback`.
3. If all fallbacks fail, apply the stage's `onFailure` policy.
4. A successful fallback MUST be recorded in `$ARTIFACTS_DIR/<issue-id>/runtime.json` so the operator can audit which harness actually ran.

Fallback MUST NOT trigger on stage *content* failures (the agent ran but produced a wrong answer). Fallback is exclusively for *availability* failures (harness CLI missing, API down, rate limit, capability mismatch detected at runtime). Distinguishing these is the adapter's responsibility — adapters MUST map provider errors into the `HarnessResult.status` taxonomy correctly.

### 13.6 Cross-harness review pattern

The recommended routing in §11.3 places `review-critic` and `review-security` on `codex` while leaving `implement` on `claude-code`. This is deliberate: the review's value comes partly from being performed by a different model family than the one that wrote the code. The pattern generalizes:

- Code written by Claude (via `claude-code`) → reviewed by GPT-5 (via `codex`)
- Code written by GPT-5 (via `codex`) → reviewed by Claude (via `claude-code`)

Operators MAY configure the inverse routing (e.g., for clients with only OpenAI credentials available) by amending the pipeline's `defaultHarness` and the relevant stage `harness` fields. The classifier (§12) MAY emit `harnessOverride` in addition to `modelOverride` if a specific PR shape benefits from a specific reviewer harness.

**Preserving independence under fallback.** The recommended routing assumes the primary harness for `implement` is available. If `claude-code` is rate-limited and `implement` falls back to `codex`, the cross-harness independence property silently degrades — both `implement` and `review-security` would now run on `codex`. To prevent this degradation, the reference pipeline declares `requiresIndependentHarnessFrom: [implement]` on `review-critic` and `review-security`. The orchestrator then enforces the independence constraint per §13.10 — if no harness in the review stages' chain preserves independence after `implement` fell back, the orchestrator emits `IndependenceViolated` and applies the stage's `onFailure` policy. Security-critical pipelines SHOULD set `onFailure: abort` for these stages; advisory pipelines MAY set `continue`.

### 13.7 Adapter ownership and security

Adapters live in-tree at `orchestrator/src/harness/adapters/`. Third-party adapters are NOT supported in v1 — every adapter is reviewed by the maintainers because it executes external CLIs with full credentials in scope. A stage's credentials (RFC-0002 §3 `credentials` field) MUST be made available to the chosen harness without exposure to other harnesses in the fallback chain. Each adapter is responsible for scrubbing its own environment before invocation.

### 13.8 Version pinning and startup probe

Each adapter declares the upstream binary it depends on and the version range it has been written against:

```typescript
// orchestrator/src/harness/adapters/claude-code.ts
readonly requires: HarnessRequires = {
  binary: 'claude',
  versionRange: '>=2.0.0',                          // open-ended upper bound by default
  versionProbe: {
    args: ['--version'],
    parse: (stdout) => stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
  },
};
```

**Default policy: open-ended upper bounds.** Adapters SHOULD declare `>=X.Y.Z` rather than `>=X.Y.Z <X+1.0.0`. We assume forward-compatibility unless a specific upstream version is known to break compat. This avoids the "pinned upper bound forces operators onto downgrades after every minor upstream release" trap.

**When to pin an upper bound.** Only when a specific upstream version is verified incompatible (e.g., Claude Code 3.0 ships a breaking CLI flag change that our adapter has not been updated for). The pin is removed in the same patch that updates the adapter for compat.

**Probe semantics (called from `isAvailable()`):**

| Outcome | Returned `HarnessAvailability` | Validation impact |
|---|---|---|
| Binary not on PATH | `{ available: false, reason: 'binary-missing' }` | Pipeline-load fails for primary; fallback removed with warning. |
| Binary present, version in range | `{ available: true, installedVersion }` | Validation proceeds. |
| Binary present, version below range | `{ available: false, reason: 'version-out-of-range', detail: 'claude 1.8.2 installed, adapter requires >=2.0.0; run `npm install -g @anthropic-ai/claude-code@latest`' }` | Pipeline-load fails for primary; fallback removed with warning. |
| Binary present, version above pinned upper bound (rare) | `{ available: false, reason: 'version-out-of-range', detail: 'claude 3.0.1 installed, adapter pinned to <3.0.0; adapter update required' }` | Same as above. |
| Probe parsing failed (e.g., `--version` output format changed) | `{ available: true, reason: 'probe-failed', detail: 'could not parse claude --version output: ...' }` | Validation proceeds with `HarnessProbeFailed` warning. |
| Adapter-specific health check failed (e.g., API token missing) | `{ available: false, reason: 'health-check-failed', detail }` | Pipeline-load fails. |

**Why parse failures fall through to "available."** Vendor `--version` output format is undocumented and can change without notice. Treating parse failure as "unavailable" would break every pipeline the moment a vendor rewords their version banner. The warning surfaces the issue to the maintainer (registry-freshness telemetry, §11.6) without disrupting operators.

**Probe caching.** `isAvailable()` MAY cache its result for the orchestrator's lifetime. Binaries on the PATH do not change underneath a running process. Operators upgrading a CLI MUST restart the orchestrator to pick up the new version. The cached result is invalidated on orchestrator restart.

**Probe budget.** Adapters MUST complete the version probe within 5 seconds. Slower probes are treated as `probe-failed`. This protects pipeline-load latency on hosts with degraded filesystems or slow CLIs.

### 13.9 Schema-conformant artifact emission

Every adapter MUST produce schema-conformant JSON artifacts per §16.4. Concretely:

1. The adapter's invocation prompt for any artifact-producing stage MUST include the JSON Schema for that artifact (read from `spec/schemas/artifacts/<name>.schema.json`) inline in the prompt, with explicit instruction to emit a conformant JSON file at the documented path.
2. The adapter MUST validate the produced JSON against the schema before returning `HarnessResult.status = 'success'`.
3. On first-attempt validation failure: the adapter MUST retry once with a sharpened prompt that includes the validator error message and re-emphasizes the schema requirement.
4. On retry failure: the adapter MUST set `HarnessResult.status = 'failure'` with `errorDetail` naming the schema validation error, and the orchestrator emits `ArtifactSchemaInvalid`.

This is the cross-harness contract that lets downstream stages consume any harness's output uniformly. Adapter authors who skip the validation step are introducing a silent-corruption hazard that invalidates the cross-harness review pattern (§13.6) — review never integrates without it.

### 13.10 Harness independence enforcement

When a stage declares `requiresIndependentHarnessFrom: [stageA, stageB, ...]`, the orchestrator MUST filter the stage's effective harness chain to preserve independence from those upstream stages.

**Algorithm (at dispatch time):**

1. Read each named upstream stage's `runtime.json` to determine the harness that actually ran (which MAY differ from the declared `harness` if a fallback was used).
2. Build the forbidden set: `forbidden = { resolved harness for each named upstream stage }`.
3. Build the candidate chain: `candidates = [stage.harness] + stage.harnessFallback`.
4. Filter: `effective = candidates.filter(h => !forbidden.includes(h))`.
5. If `effective` is non-empty: dispatch using `effective` as the new harness chain. Record both the original chain and the filtered chain in this stage's `runtime.json` for audit.
6. If `effective` is empty: emit `IndependenceViolated` event naming the forbidden set and the empty chain. Apply the stage's `onFailure` policy.

**Default `onFailure` for `IndependenceViolated`.** When the stage does not declare `onFailure`, the orchestrator treats `IndependenceViolated` as `continue` (advisory) for the dogfood pipeline. Security-critical pipelines SHOULD declare `onFailure: abort` on stages where independence is load-bearing — `IndependenceViolated` then halts the pipeline with the operator deciding whether to wait for fallback availability or accept the degraded property.

**Observability.** `IndependenceViolated` events are surfaced in `_events.jsonl` (§17) and the Slack integration regardless of `onFailure` policy. Operators MUST be informed when independence is compromised even if the pipeline was configured to continue. Without this signal, "review caught nothing" could silently mean "review caught nothing because reviewer was the same harness as implementer."

**Cyclic guard.** If `requiresIndependentHarnessFrom` references a downstream stage (creating a cycle), pipeline-load FAILS with `CyclicIndependenceConstraint`. Validation runs at load time, not dispatch.

**Example (from the reference pipeline):**

```yaml
- name: implement
  harness: claude-code
  harnessFallback: [codex]
- name: review-security
  harness: codex
  harnessFallback: [claude-code]
  requiresIndependentHarnessFrom: [implement]
  onFailure:
    on: IndependenceViolated
    strategy: continue          # advisory; operator overrides for security-critical pipelines
```

If `implement` runs on `claude-code` (no fallback): `review-security` candidates = `[codex, claude-code]`, filtered = `[codex]`. Dispatch on codex. Independence preserved.

If `implement` falls back to `codex`: `review-security` candidates = `[codex, claude-code]`, filtered = `[claude-code]`. Dispatch on claude-code. Independence preserved (different harness from implementer).

If both `claude-code` and `codex` are unavailable: `implement` falls back through its chain (or the pipeline aborts per its `onFailure`). The independence question becomes moot because the pipeline isn't progressing.

## 14. Subscription-Aware Scheduling

### 14.1 The optimization frame

Maximize:
```
   Σ(PPA_score(issue) × completion_indicator(issue))
   over all issues in queue
   subject to:
     Σ(estimated_tokens(stage) / window_multiplier(time)) ≤ window_quota
     for every billing window in the planning horizon
```

In plain language: process as many high-PPA issues as possible per subscription window, exploiting off-peak multipliers where they exist, without exceeding hard caps. This is a bounded knapsack problem solved on every dispatch decision.

### 14.2 SubscriptionLedger interface

```typescript
interface SubscriptionLedger {
  // Current state for a harness, summed across all SubscriptionPlans.
  windowState(harness: string): WindowState;

  // Can a stage with these estimated tokens be dispatched now without
  // exceeding the hardCap? Returns 'yes' | 'wait-until-T' | 'no'.
  admit(harness: string, estimatedTokens: TokenEstimate): AdmissionDecision;

  // Record observed consumption from a completed stage invocation.
  // Updates rolling estimates and pacing projections.
  record(harness: string, actual: TokenUsage, when: Date): void;

  // Is now within an off-peak window for this harness?
  isOffPeak(harness: string, when?: Date): boolean;

  // When does the next off-peak window start, if any?
  nextOffPeakStart(harness: string): Date | null;

  // Projected utilization at window-end given current pace + queued work.
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

The ledger persists state at `$ARTIFACTS_DIR/_ledger/<harness>-<accountIdShort>-<tenant>.json` (where `accountIdShort` is the first 8 chars of `getAccountId()`'s hash and `tenant` is the resolved tenant or `__default__`, per the keying defined in §14.12) so it survives orchestrator restarts within a window. One file per ledger key.

### 14.3 Schedule semantics

When dispatching a queued issue's stage:

1. Resolve the stage's effective harness (§13).
2. Consult `ledger.admit(harness, estimatedTokens)`.
3. Apply the stage's `schedule`:

| `schedule` | Behavior |
|---|---|
| `now` | Dispatch if admit returns `yes`; if `wait-until-T` < 60s wait; if `no` apply `onFailure`. |
| `off-peak` | If `isOffPeak(harness)`, dispatch as `now`. Else compute `nextOffPeakStart`; if within `Pipeline.spec.offPeakMaxWait` (default `PT8H`), defer; else dispatch on-peak with a `OffPeakDeferralExceeded` warning. |
| `quota-permitting` | Dispatch only if `projectedUtilization(harness) + this stage's tokens` ≤ `hardCap`. Else requeue with backoff. |
| `defer-if-low-priority` | Dispatch immediately if PPA score is in the top quartile of the queue OR the window has > 30% headroom. Otherwise behave as `off-peak`. |

### 14.4 Burn-down pacing

Every 5 minutes (configurable), the orchestrator MUST emit a `BurnDownReport` event for each harness:

```json
{
  "harness": "claude-code",
  "ledgerKey": { "harness": "claude-code", "accountId": "a3f2c891", "tenant": "__default__" },
  "windowEnd": "2026-04-26T22:30:00-07:00",
  "subscriptionTokensConsumed": 412000,
  "quotaTokens": 1000000,
  "subscriptionUtilizationFraction": 0.412,
  "dollarsSpent": 0.00,
  "shadowCostUsd": 11.40,
  "pacingTarget": 0.85,
  "projectedUtilization": 0.71,
  "queueDepth": 4,
  "recommendation": "under-pacing — consider promoting deferred work"
}
```

Field semantics per §14.10: `subscriptionTokensConsumed` is within-quota work (zero dollar impact), `dollarsSpent` is pay-per-token spillover that decremented `costBudget`, `shadowCostUsd` is the informational "what would this have cost on the API" value for ROI reporting, `subscriptionUtilizationFraction` is the headline metric for tier-fit decisions.

Three recommendation categories:
- **`under-pacing`**: projectedUtilization < pacingTarget − 0.10 → emit hint to promote `defer-if-low-priority` and `off-peak` work even if outside off-peak window.
- **`on-pace`**: pacingTarget − 0.10 ≤ projectedUtilization ≤ pacingTarget + 0.05 → no action.
- **`over-pacing`**: projectedUtilization > pacingTarget + 0.05 → emit hint to defer `defer-if-low-priority` and `quota-permitting` work; do not dispatch new such stages.

### 14.5 Off-peak window enrichment

The `SubscriptionPlan.spec.offPeak.schedule` is operator-declared based on the vendor's documented off-peak hours (subject to change). The orchestrator MUST NOT assume off-peak hours from any other source. When the vendor publishes a quota-introspection API, this RFC's ledger interface is forward-compatible per §14.11: `windowState()` becomes a query against authoritative state.

**Freshness signal.** Operators declare `offPeak.lastVerified: ISO 8601 date` on each SubscriptionPlan. At pipeline-load:

| Condition | Behavior |
|---|---|
| `lastVerified` absent | Emit `OffPeakScheduleStale` warning naming the plan and recommending the operator verify against current vendor docs. Pipeline loads. |
| `lastVerified` present, age ≤ 30 days | No warning. |
| `lastVerified` present, age > 30 days | Emit `OffPeakScheduleStale` warning naming the plan and the verification age (e.g., "verified 47 days ago"). Pipeline loads. |
| `lastVerified` present, age > 90 days | `OffPeakScheduleStale` warning escalates to ERROR severity. Pipeline still loads, but the warning is highlighted in `cli-status` and surfaces immediately in Slack rather than the daily digest. |

**Why advisory, not blocking.** The cost of a stale schedule is bounded — burn-down projections become slightly off, off-peak deferrals dispatch into windows that may not actually be off-peak. None of this is a safety property. Blocking pipeline-load on a stale date would be alarm fatigue when the actual fix is a one-line YAML edit.

**Surfacing.** `OffPeakScheduleStale` events are part of the Slack daily-digest payload (`project_slack_integration.md`) so operators see them in their normal workflow. The `cli-status --subscriptions` view (§17) shows each plan's `lastVerified` age in a column, color-coded: green (≤30d), yellow (30–90d), red (>90d).

**Reference plan maintenance.** The reference SubscriptionPlan examples shipped at `spec/examples/subscription-plans/*.yaml` MUST include `lastVerified` populated from the date a maintainer last reviewed the example against vendor docs. The maintainer team SHOULD refresh these dates at least quarterly; CI MAY include a freshness check that fails if any reference example's `lastVerified` is older than 90 days.

### 14.6 Token-estimate calibration

The `Stage.estimatedTokens` field bootstraps the ledger's headroom math. After each stage execution, the orchestrator MUST update a per-stage rolling estimate (last 20 invocations, exponentially weighted) at `$ARTIFACTS_DIR/_ledger/stage-estimates.json`. Future dispatch decisions consult the rolling estimate, not the operator-declared bootstrap. Operators MAY override at any time by re-declaring the field; the override resets the rolling history.

#### 14.6.1 Cold-start defaults

When `Stage.estimatedTokens` is omitted, the orchestrator uses a flat default and self-calibrates from the first run:

| Source | Used when | Lifetime |
|---|---|---|
| `Stage.estimatedTokens` (operator-declared) | Field is present in pipeline YAML | Until rolling estimate has 1+ samples; then rolling supersedes UNLESS operator-declared value is treated as a *frozen* lock (see below) |
| Cold-start default `{ input: 50000, output: 10000 }` | Field absent AND no rolling history exists | Single use; replaced by rolling estimate after first execution |
| Rolling estimate (last 20 invocations, exp-weighted) | Field absent AND rolling history has ≥1 sample | Until pipeline YAML adds `estimatedTokens`, which resets the rolling history |

At pipeline-load, every stage with absent `estimatedTokens` AND no rolling history emits `MissingEstimate` warning naming the stage and the default about to be applied. Pipeline loads regardless — the default is good enough for first-run admission decisions on most stages.

#### 14.6.2 EstimateBootstrapped event

On the second dispatch of any stage that ran first with the cold-start default, BEFORE the admission check, the orchestrator MUST emit a one-time `EstimateBootstrapped` event:

```json
{
  "timestamp": "2026-04-26T16:00:00Z",
  "stage": "implement",
  "issueId": "AISDLC-247",
  "coldStartDefault": { "input": 50000, "output": 10000 },
  "firstRunActual": { "input": 184320, "output": 41200 },
  "newRollingEstimate": { "input": 184320, "output": 41200 },
  "divergenceFromDefault": { "inputRatio": 3.69, "outputRatio": 4.12 },
  "interpretation": "first-run actuals 3.7× input default; future admission uses rolling estimate. Consider declaring `estimatedTokens` in pipeline YAML if first-run admission decisions matter."
}
```

The event is also written as a header line to `$ARTIFACTS_DIR/_ledger/stage-estimates.json` so operators can see the bootstrap moment when reading the file later.

#### 14.6.3 Frozen estimates (opt-out from rolling)

Some stages have bimodal consumption patterns where the rolling average produces bad admission decisions (e.g., 90% of `fix-pr` runs are tiny mechanical fixes; 10% are large refactors; the rolling mean undersizes the large case and oversizes the small one). Operators MAY freeze an estimate to opt out of rolling updates:

```yaml
- name: fix-pr
  estimatedTokens:
    input: 200000
    output: 30000
    frozen: true            # rolling estimates do NOT supersede this value
```

When `frozen: true`, the rolling estimate is still maintained for telemetry but the dispatcher uses the declared value for admission. This is rare — operators SHOULD only freeze after they have rolling-estimate data showing the rolling average is materially wrong.

#### 14.6.4 Reference defaults

The dogfood reference pipeline (`spec/examples/pipelines/dogfood.yaml`) declares `estimatedTokens` for every canonical stage so the cold-start default applies only to operator-authored novel stages. Reference values (subject to calibration after deployment):

| Stage | Input | Output | Notes |
|---|---|---|---|
| `triage` | 8,000 | 2,000 | Haiku-sized; small prompt + small JSON output |
| `review-classify` | 12,000 | 1,500 | Haiku; reads diff + emits classifier JSON |
| `plan` | 80,000 | 8,000 | Sonnet; reads codebase context + emits plan |
| `implement` | 250,000 | 40,000 | Opus 1M; multi-file edits |
| `validate` | 60,000 | 6,000 | Sonnet; reads test output |
| `review-testing` | 90,000 | 8,000 | Sonnet |
| `review-critic` | 90,000 | 8,000 | Sonnet, cross-harness |
| `review-security` | 90,000 | 8,000 | Sonnet, cross-harness |
| `fix-pr` | 120,000 | 15,000 | Mechanical fixes; bimodal — operator MAY freeze |
| `simplify` | 70,000 | 8,000 | Sonnet; localized refactor |

### 14.7 Recommended scheduling for the dogfood pipeline

Non-normative guidance the reference implementation SHOULD ship as defaults:

| Stage | `schedule` | Rationale |
|---|---|---|
| `triage` (PPA scoring) | `now` | Cheap, blocks queue ordering |
| `review-classify` | `now` | Cheap, gates the review fan-out |
| `plan` | `now` | Blocks downstream implementation |
| `implement` | `quota-permitting` | Most expensive stage; burst when window allows |
| `validate` | `now` | Tightly coupled to implement |
| `review-*` | `defer-if-low-priority` | High-PPA PRs get reviewed immediately; low-PPA can wait for off-peak |
| `simplify` (cleanup pass) | `off-peak` | Always cost-flexible; pure off-peak workload |
| `fix-pr` | `now` for critical, `quota-permitting` otherwise | Bug-fix urgency varies |

### 14.8 Interaction with PPA priority

PPA score (RFC-0008) and `schedule` are orthogonal but composable:

- The dispatch queue is PPA-ordered.
- Within a single dispatch decision, `schedule` constrains *when* a stage can run.
- A high-PPA stage with `schedule: now` always wins over a low-PPA stage with `schedule: now` for the next available slot.
- A high-PPA stage with `schedule: now` blocked on `hardCap` does NOT cede priority to a lower-PPA stage that would fit — the orchestrator emits a `QuotaContention` event so the operator can decide whether to upgrade the subscription tier or wait.
- Off-peak dispatch reorders: during off-peak, `defer-if-low-priority` and `off-peak` stages from the back half of the PPA queue MAY dispatch ahead of mid-queue `now` stages if the latter's harness is at hardCap.

### 14.9 Multi-harness load balancing

When the same model is available on multiple harnesses with different SubscriptionPlans (e.g., Claude on Claude Code session-window AND on Anthropic API pay-per-token), the orchestrator routes to the harness with:

1. Available headroom in current window (session-window plans only).
2. Off-peak multiplier currently active (preferred).
3. Lower projected unit cost given remaining quota.

This creates a soft preference for "free" subscription capacity over paid API capacity, with automatic spillover when subscription is exhausted.

### 14.10 Cost model: dollars vs subscription tokens

The relationship between subscription quota and dollar spend is not 1:1, and operators routinely confuse the two. This subsection pins down the model.

**Subscription work is pre-paid.** A `claude-code-max-5x` subscription has been billed at month-start. Every token consumed within the window's quota costs `$0` *at the moment of consumption*. The dollar cost was sunk when the subscription was purchased; the marginal cost of the next token is zero until the window's `windowQuotaTokens` is exhausted.

**Spillover work is pay-per-token.** When a stage cannot be admitted on a subscription harness (window exhausted, hardCap reached, harness unavailable), the orchestrator falls over per §13.5 to the next harness in `harnessFallback`. If that harness is `pay-per-token` (e.g., Anthropic API direct, OpenRouter), the stage's tokens DO incur dollar cost at the model's per-token rate.

**Implication for `costBudget` accounting:**

| Work type | Decrements `costBudget`? | Decrements subscription window? |
|---|---|---|
| Stage on subscription harness, within window quota | **No** (sunk cost) | Yes |
| Stage on subscription harness, hardCap reached → spills to pay-per-token | Yes | No (the spillover stage runs on pay-per-token, not on subscription) |
| Stage on `pay-per-token` harness directly | Yes | N/A |
| Stage on subscription harness in off-peak window | No | Yes, but at `1 / multiplier` rate (a 100K-token call consumes 50K of quota when `multiplier: 2.0`) |

**Shadow cost reporting.** For analytics and "would this have cost $X on the API" comparisons, the cost-attribution ledger (§11.4) MAY record a `shadowCostUsd` per stage that reflects what the work would have cost on pay-per-token. This value is informational ONLY — it does NOT decrement `costBudget`. Operators use it to evaluate "am I getting more value from this subscription than I would from pay-per-token?" — the implicit ROI metric on the subscription itself.

**Why `costBudget` does not include shadow cost.** A pipeline with `costBudget: $50/day` should not block when shadow cost crosses $50 if all the work was done on a paid-up subscription. That would defeat the entire point of paying for the subscription. The dollar budget enforces against actual incremental spend the operator will see on a credit-card statement, not against accounting fictions.

**When subscription quota maps directly to dollars.** Only at the spillover threshold. When the orchestrator is about to dispatch a stage and the projected `windowQuotaTokens` consumption would push utilization past `hardCap`, the dispatcher computes the spillover cost (the same work routed to `pay-per-token`) and treats THAT as the value to check against `costBudget`. If spillover would breach `costBudget`, the stage waits for the next window rather than spilling. This couples the two caps cleanly: subscription work is free (within quota), spillover work is dollar-budgeted, and the operator never silently overspends.

**Reporting view.** The burn-down report (§14.4) MUST distinguish:
- `subscriptionTokensConsumed` — within-quota work (no dollar impact).
- `dollarsSpent` — pay-per-token work that decremented `costBudget`.
- `shadowCostUsd` — informational; sum of (subscription tokens × pay-per-token rate) for the same window.
- `subscriptionUtilizationFraction` — how much of the pre-paid subscription was actually used.

The fourth metric is the headline number for "is my subscription paying for itself?" and is the most actionable for tier-upgrade decisions.

### 14.11 Quota-source migration

The SubscriptionLedger (§14.2) tracks window state from one of three sources, declared per-plan via `SubscriptionPlan.spec.quotaSource`:

| Value | Behavior |
|---|---|
| `self-tracked` (default) | Ledger maintains its own running tally from observed token consumption. Used today because no vendor exposes a quota-introspection API. Estimate accuracy depends on the calibration loop (§14.6). |
| `authoritative-api` | Ledger queries the vendor API on every admission decision. If the API is unavailable, admission FAILS CLOSED — no dispatch until the API responds. Strict but expensive (one extra round-trip per admission). |
| `authoritative-with-fallback` | Ledger prefers authoritative API; on API unavailable, falls back to self-tracked state with a `LedgerSourceFallback` warning. Soft mode for production migrations where availability matters more than strict accuracy. |

**Pinning.** `quotaSource` is read at pipeline-load and pinned for the run's lifetime, like model resolution (§11.1) and harness chains. Switching mid-run is not supported — operators restart the pipeline to change sources.

**First-switch reconciliation.** When a pipeline starts with a `quotaSource` other than `self-tracked` AND the ledger has prior `self-tracked` state from a previous run on the same plan, the orchestrator MUST emit a one-time `LedgerReconciliation` event:

```json
{
  "timestamp": "2026-04-26T15:00:00Z",
  "plan": "claude-code-max-5x",
  "previousSource": "self-tracked",
  "newSource": "authoritative-api",
  "selfTrackedUtilization": 0.60,
  "authoritativeUtilization": 0.85,
  "absoluteDivergence": 0.25,
  "relativeDivergence": 0.42,
  "interpretation": "self-tracker was UNDER-estimating consumption by 25 points; future dispatch decisions tighten under authoritative source",
  "recommendation": "review pre-migration burn-down reports — they may have over-reported headroom"
}
```

The event is also written to `$ARTIFACTS_DIR/_ledger/<plan>-reconciliation.jsonl` for audit. Operators MUST review divergence after first switch — significant gaps (>10 points) signal the self-tracker was mis-calibrated and historical decisions warrant re-examination.

**Backfill is out of scope.** If/when an authoritative API exposes per-window historical state ("give me my consumption from 4h ago"), the orchestrator MAY backfill the ledger's history. v1 does not attempt this; the reconciliation event captures the moment-of-switch divergence only. Future enhancement.

**Drift detection (soft prompt).** When a plan with `quotaSource: self-tracked` runs against a vendor that has since shipped an authoritative API (orchestrator detects the API endpoint exists per harness adapter signal), the orchestrator MAY emit a `QuotaSourceUpdateRecommended` warning. This does not change behavior — operators control when to flip the opt-in. The signal exists so the soft-default doesn't become invisibly stale years after the API ships.

**Why opt-in.** Vendor APIs ship with their own bugs, rate limits, and consistency models. Silently flipping every operator's pipeline to the new source on first orchestrator startup after the API ships would be a behavior change underneath them — exactly the property §11.1 (model pinning) and Q5 resolution went out of their way to prevent. Operator-controlled opt-in respects the same invariant.

### 14.12 Multi-tenant ledger keying

The SubscriptionLedger is keyed by `(harness, accountId, tenant)` so multiple pipelines correctly share or isolate quota based on what the vendor sees as one account.

**Resolution:**

| Component | Source | Behavior |
|---|---|---|
| `harness` | Stage's resolved harness (§13) | Different harnesses → different ledgers always (different vendors / different windows) |
| `accountId` | `harnessAdapter.getAccountId()` (§13.1) | Auto-derived from credentials. Two pipelines using the same API key get the same `accountId` → same ledger. Different keys → different ledgers. When `getAccountId()` returns `null`, see "ambiguous" below. |
| `tenant` | `Pipeline.spec.tenant` | Optional. When set, partitions the `(harness, accountId)` ledger into virtual sub-windows. When omitted, defaults to `__default__` so all untenanted pipelines on the same account share. |

**Auto-pooling example:** Two pipelines `dogfood` and `client-onboarding` both run on the same operator's Anthropic API key. `getAccountId()` returns the same hash for both. Both omit `Pipeline.spec.tenant`. Ledger key is `(claude-code, hash(key), __default__)` — single shared ledger. Burn-down across both pipelines correctly reflects the shared window.

**Auto-isolation example:** Client A and Client B run on the same orchestrator host but with separate Anthropic accounts. Their API keys differ → `getAccountId()` returns different hashes → separate ledgers. Client A's runaway dispatch cannot affect Client B's headroom because the ledgers don't share state.

**Tenant overlay example:** A parent organization has one Anthropic account but wants to attribute spend to two internal teams (`team-platform` and `team-product`). Both pipelines declare:

```yaml
# pipeline-platform.yaml
spec:
  tenant: team-platform
  tenantQuotaShare: 0.6

# pipeline-product.yaml
spec:
  tenant: team-product
  tenantQuotaShare: 0.4
```

Each tenant gets a virtual sub-window of `windowQuotaTokens × share`. Team-platform sees 60% of the account's quota; team-product sees 40%. The vendor still sees one account; the orchestrator enforces internal partitioning. Ledger keys are `(claude-code, hash(key), team-platform)` and `(claude-code, hash(key), team-product)`.

**Validation at orchestrator startup:**

1. For each loaded pipeline, derive `(harness, accountId, tenant)`.
2. Group pipelines by `(harness, accountId)`.
3. For each group:
   - If all pipelines omit `tenant` → single shared ledger keyed `(harness, accountId, __default__)`. No share validation.
   - If any pipeline declares `tenant` → ALL pipelines in the group MUST declare `tenant` AND `tenantQuotaShare`. Sum of shares MUST equal 1.0 (±0.001 tolerance). Mixed declared/undeclared OR sum ≠ 1.0 → orchestrator startup FAILS with `TenantShareInvalid` naming the conflicting pipelines.

**Ambiguous accountId.** When `getAccountId()` returns `null` (e.g., generic-api harness with an opaque token, or a credential scheme that doesn't expose stable identity):

1. Orchestrator emits `LedgerKeyAmbiguous` warning at pipeline-load naming the harness and pipeline.
2. Ledger degrades to per-pipeline keying: `(harness, 'pipeline:' + pipeline.metadata.name, tenant)`.
3. This means two pipelines on the same actual vendor account but using an ambiguous-id harness will NOT auto-pool — operators get the per-pipeline isolation behavior of pre-§14.12 systems.
4. Operators can recover correct pooling by declaring `Pipeline.spec.accountId: <stable identifier>` to override the auto-derivation. This is rare; documented for completeness.

**LedgerPooled audit event.** When a pipeline loads and its `(harness, accountId, tenant)` matches an existing active ledger from another pipeline, the orchestrator MUST emit `LedgerPooled` event naming both pipelines. This is informational, not a warning — pooling is the correct behavior on shared accounts. The event lets operators spot-check that pooling matches their intent (i.e., they didn't accidentally share keys across truly separate concerns).

**`cli-status --subscriptions` view.** Groups rows by `(harness, accountId)` so operators see at a glance which pipelines pool. Each tenanted row shows its `tenantQuotaShare` and the share of the parent window currently consumed. Account IDs in the display are truncated hashes (first 8 chars) to avoid leaking credential identity in screenshots/logs while remaining useful for operator pattern-matching.

### 14.13 Tier recommendation

The orchestrator aggregates `QuotaContention` events per `(harness, accountId, tenant)` over each billing window and writes a `TierAnalysis` record weekly. The analysis surfaces "should you upgrade or downgrade your subscription tier" recommendations grounded in observed contention.

**Aggregation cadence.** Once per `SubscriptionPlan.spec.windowDuration` for session-window plans (typically every Monday morning for weekly review), or once per calendar month for monthly-cap plans. Records are written to `$ARTIFACTS_DIR/_ledger/tier-analysis.jsonl` (append-only).

**TierAnalysis record structure:**

```json
{
  "billingPeriod": "2026-W17",
  "ledgerKey": { "harness": "claude-code", "accountId": "a3f2c891", "tenant": "__default__" },
  "currentPlan": "claude-code-pro",
  "currentPlanCostUsd": 20,
  "contentionEvents": 47,
  "cumulativeContentionDuration": "PT12H",
  "issuesDeferredOffPeak": 14,
  "issuesBlockedOnHardCap": 3,
  "recommendedPlan": "claude-code-max-5x",
  "recommendedPlanCostUsd": 100,
  "projectedTimeSaved": "PT9H",
  "projectedAdditionalIssuesProcessed": 11,
  "projectedSpilloverSavingsUsd": 18,
  "confidence": "high",
  "reasoning": "Pro tier hit hardCap on 3 issues this week, totaling 12 hours of cumulative wait. At Max-5x, projected utilization stays below pacingTarget with current dispatch rate. Marginal cost +$80/week unlocks 11 additional issues processed plus $18/week reduced spillover-to-pay-per-token."
}
```

**Confidence buckets:**

| Bucket | Trigger | Recommendation strength |
|---|---|---|
| `low` | <5 contention events in window | Suppressed from Slack digest; visible only via CLI |
| `medium` | 5–20 contention events | Surface in digest IF `recommendedPlan != currentPlan` |
| `high` | >20 contention events | Surface in digest IF `recommendedPlan != currentPlan` |

Qualitative buckets (rather than continuous probability) avoid precision-theater on a recommendation derived from inherently noisy signals. Operators understand "high confidence based on 47 events" better than "0.83 confidence."

**Slack digest suppression rules.** A `TierAnalysis` is included in the daily digest only when:

1. `confidence != 'low'` (enough data to support a recommendation), AND
2. `recommendedPlan != currentPlan` (there's an actual change to recommend).

Recommendations confirming the current plan are silenced — operators don't need a weekly "your tier is fine" message. The CLI command (below) shows them on demand.

**CLI command.** `cli-tier-recommendation` renders the most recent `TierAnalysis` for each ledger key. Flags:

- `--last <N>` — show the last N records, not just the most recent.
- `--details` — include the per-event contention breakdown (which stages, which issues, what hour of day).
- `--all-tenants` — across all `(harness, accountId, tenant)` keys; default shows only the current pipeline's key.

**Bidirectional recommendations.** The analysis MAY recommend downgrading. When `currentPlan: max-5x` runs at <40% utilization for 4 consecutive billing periods AND `confidence: high`, the recommendation MAY be `claude-code-pro` with `projectedSavingsUsd`. The orchestrator does not bias toward upgrades — operators waste money in either direction. The Slack digest entry for downgrade recommendations uses softer language ("you may be over-provisioned") to avoid implying urgency.

**Why not real-time alerts.** Quota contention is rarely an emergency requiring same-day action. Real-time `TierUpgradeRecommended` events would train operators to ignore the channel. The weekly digest cadence matches typical subscription-review workflow. Operators who want sharper feedback can lower the bucketing thresholds via configuration in a future enhancement.

**Plan corpus.** Recommendations are drawn from the registered `SubscriptionPlan` resources available to the orchestrator. The reference implementation ships plans for `claude-code-pro`, `claude-code-max-5x`, `claude-code-max-20x`, `codex-plus`, `codex-pro`, and `pay-per-token` (per Phase 2.8 implementation plan). Operators with custom plans MUST register them as `SubscriptionPlan` resources for the recommender to consider them.

## 15. Database Isolation

### 15.1 DatabaseBranchAdapter interface

Every adapter MUST implement the following TypeScript interface (declared at `orchestrator/src/database/types.ts`):

```typescript
interface DatabaseBranchAdapter {
  readonly name: string;                       // 'neon', 'sqlite-copy', etc.
  readonly capabilities: DatabaseBranchCapabilities;

  // Validate at pipeline-load: credentials present, upstream reachable,
  // no obvious misconfiguration.
  validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult>;

  // Provision a new branch from the pool's upstream. Returns the
  // connection string the agent should use.
  allocate(pool: ResolvedDatabaseBranchPool, branchKey: string): Promise<DatabaseBranchHandle>;

  // Destroy a branch and free its quota slot.
  reclaim(handle: DatabaseBranchHandle): Promise<void>;

  // List currently active branches in the upstream account, scoped to this pool.
  // Used for stale-branch sweep on orchestrator startup.
  list(pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]>;

  // Liveness probe.
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

Connection strings MUST be treated as secrets: never written to `state.json`, never appearing in event-stream messages, never logged outside the adapter. The orchestrator passes them only as agent-process env vars, never as command-line arguments.

### 15.2 Adapter registry and capability matrix

The reference implementation ships these four adapters at v1:

| Capability | `sqlite-copy` | `neon` | `pg-snapshot-restore` | `external` |
|---|---|---|---|---|
| `branchCreationLatencyP50Ms` | ~50 | ~1500 | ~30000–180000 | declared |
| `maxBranches` | filesystem | 5000 (Neon free), more on paid | RDS-account quota | declared |
| `supportsMigrations` | ✅ | ✅ | ✅ | declared |
| `supportsReadOnlyBranches` | ✅ (hardlink) | ✅ | ❌ | declared |
| `supportsBranchFromBranch` | ✅ | ✅ | ❌ | declared |
| `multiDatabase` | ❌ (per-file) | ❌ (per-project) | ❌ | declared |
| `costModel` | `free` | `per-branch-storage` | `per-snapshot` | declared |
| Recommended for | local dev, SQLite apps | Neon/Postgres production | RDS/vanilla Postgres | escape hatch |

**`sqlite-copy`** — copies the upstream `.sqlite` file to `<worktree>/.ai-sdlc/db/<branchKey>.sqlite`. Hardlinks for read-only branches. Reclamation deletes the file. No external dependencies.

**`neon`** — calls Neon's API to create a branch from the upstream branch. Uses `NEON_API_TOKEN` and `projectId`. Branch creation is ~1.5s P50; reclamation is immediate. Branches share storage with upstream until divergent writes occur (cheap).

**`pg-snapshot-restore`** — for vanilla Postgres or AWS RDS. Uses `pg_dump` + `pg_restore` (vanilla) or RDS snapshot/restore APIs (AWS). Creation latency 30s–3min; cost is full storage per branch. Recommended only when Neon/Supabase aren't available.

**`external`** — operator declares `allocate.command` and `reclaim.command` shell hooks that the orchestrator invokes. The hook is responsible for printing the connection string on stdout. Escape hatch for proprietary or custom branching mechanisms.

The `external` adapter executes operator-controlled shell commands with full credential scope; pipeline-load MUST require an explicit `acknowledgeUntrusted: true` field on the DatabaseBranchPool to opt into it.

### 15.3 Adapter-specific credentials

Credentials are passed via `DatabaseBranchPool.spec.credentials` and are adapter-specific:

```yaml
# neon
credentials:
  apiTokenEnv: NEON_API_TOKEN
  projectId: prj_abc123

# pg-snapshot-restore
credentials:
  adminConnectionStringEnv: ADMIN_DATABASE_URL  # privileged user with CREATEDB
  storageVolume: /var/lib/postgresql/branches   # where snapshots are restored

# sqlite-copy
credentials: {}  # none required; upstream file path is read from upstream.connectionStringEnv

# external
credentials:
  allocateCommand: './scripts/db-allocate-branch.sh'
  reclaimCommand: './scripts/db-reclaim-branch.sh'
  acknowledgeUntrusted: true
```

Pipeline-load MUST validate that all required credentials for the chosen adapter are present in the orchestrator's environment. Missing credentials are a load-time error, not a runtime error.

### 15.4 Branch lifecycle

For each worktree allocation:

1. The WorktreePool manager allocates the worktree (§7).
2. For each `DatabaseBranchPool` referenced in `WorktreePool.spec.databaseBranchPools[]`:
   - If `lifecycle.createOn: worktree-allocation`: invoke `adapter.allocate()` immediately.
   - If `lifecycle.createOn: first-write-stage`: defer until the first stage with `databaseAccess: write` or `migrate` dispatches.
3. If `migrations.runOnBranchCreate: true`, after `allocate()` returns, the orchestrator runs the migration command inside the worktree with the branch's connection string injected. Migration failure is fatal — the branch is reclaimed and the pipeline run aborts.
4. On stage dispatch, the agent's environment is augmented with the rewritten env vars per `injection`.
5. On worktree reclamation (PR merge, abort, timeout), all branches associated with the worktree are reclaimed via `adapter.reclaim()`.

Stale-branch sweep runs on orchestrator startup: `adapter.list()` enumerates active branches; any with `createdAt + branchTtl < now` or `lastActivity + abandonAfter < now` are reclaimed.

#### 15.4.1 Warm pool

When `lifecycle.warmPoolSize > 0`, the orchestrator maintains a pool of pre-allocated branches to amortize `adapter.allocate()` latency off the dispatch critical path. Behavior:

| Event | Action |
|---|---|
| Orchestrator startup | If `count(active branches) < warmPoolSize`, asynchronously allocate `warmPoolSize - count` warm branches. Tagged with `pool: warm` in branch metadata. |
| Stage requests allocation | If a warm branch is available: hand over (sub-100ms; rename `pool: warm → pool: active`); asynchronously allocate one replacement. If no warm branch: fall through to on-demand allocation (current behavior). |
| Branch reclaimed (PR merge / worktree reclaim / abort) | Branch is destroyed, NOT recycled into the warm pool. Next refill is a fresh allocation from upstream. |
| Warm branch ages out (`branchTtl` or `abandonAfter`) | Reclaim and asynchronously re-allocate to maintain pool size. |
| `lifecycle.maxConcurrent` reached | Warm-pool refills BLOCK until an active branch is reclaimed. Warm branches count against `maxConcurrent` along with active ones. |
| Migrations land on upstream main | Existing warm branches are stale (their schema is older). The orchestrator MUST mark them `stale: true` and drain-replace them as soon as their replacements have completed migration. Stage allocations during the drain prefer non-stale warm branches; if none available, fall through to on-demand allocation. |

**Why no recycle.** Reusing a reclaimed branch would require resetting its state (truncating tables, re-running fixtures), which is fragile and risks cross-pipeline contamination of test data. Allocating a fresh branch from upstream is simpler and the latency is hidden behind async refill anyway. Single-use branches preserve the §2.9 isolation property.

**Slot accounting.** A pool with `maxConcurrent: 10` and `warmPoolSize: 3` reserves 3 of 10 slots for warm branches. Effective active capacity is 7. Operators MUST size `maxConcurrent` accordingly when enabling a warm pool — sizing both the same starves dispatch.

**Operator guidance.** Default to `warmPoolSize: 0` until you observe latency complaints. Symptoms that warrant flipping it on:

- `BranchAllocationLatency` events showing P99 > 5s for >10% of allocations.
- Operator reports of "first stage of every issue feels slow."
- Dispatch queue backed up despite available `parallelism` slots.

Reasonable starting value: `warmPoolSize: ceil(parallelism.maxConcurrent / 3)`. Tune up if dispatch latency stays elevated; tune down if `BranchQuotaExceeded` starts firing on the warm-pool refill path.

**Observability.** The `cli-status --branches` view (§17) MUST distinguish warm vs active branches in its output, with column headers for `pool` (`warm` | `active`) and refill state (`steady` | `refilling` | `draining-stale`).

### 15.5 Migration coordination

When multiple parallel branches each add migrations, eventual merge ordering matters:

1. Each branch's PR contains its own migration files.
2. On PR merge to main, the migration is part of the merged code.
3. The next branch allocated AFTER that merge runs migrations against an upstream that already has the new schema — no conflict.
4. Branches allocated BEFORE the merge run against the upstream-at-allocation-time schema. Their tests pass, their PR merges, and the next branch picks up both migrations in order.

**The hazard:** if branch A and branch B both add a `users.preferences` column with different types, both PRs may pass review independently, and the second to merge will conflict at the migration step in main. This is a content conflict, not an infrastructure problem — the orchestrator's job is to surface it via the merge gate (§10.2 stale-base detection): if branch B's base is no longer at main HEAD, branch B rebases, the migration conflict surfaces, the orchestrator emits `MigrationConflict`, and the pipeline run suspends for operator review.

#### 15.5.1 Branch topology and migration divergence

A separate hazard arises when branches are created from other in-flight branches (rather than from a stable upstream like `dev`):

1. T0: PR-A is created. Branch-A allocated from `dev`, runs migration-A.
2. T1: PR-B is created with `upstream.branchFrom: branch-A` (chained). Branch-B inherits the migration-A schema.
3. T2: Operator abandons PR-A. Branch-A is reclaimed. Migration-A no longer exists in any merged code.
4. T3: Branch-B is now running tests against a schema that includes migration-A — a migration that lives nowhere except in branch-B's own state. When PR-B eventually merges, main has neither migration-A nor whatever PR-B was building on top of it.

**Topology guard (default).** `DatabaseBranchPool.spec.allowBranchFromBranch` defaults to `false`. The adapter MUST refuse to allocate a branch whose `upstream.branchFrom` resolves to an in-flight feature branch. Pipeline-load fails with `BranchTopologyForbidden` naming the offending pool. This eliminates the divergence hazard at the source for ~95% of pipelines that have no need for branch-from-branch chains.

**When opt-in is appropriate.** Operators with genuine stacked-PR workflows (long-lived feature branches where multiple PRs build sequentially on each other) can set `allowBranchFromBranch: true`. The opt-in is friction by design — it forces operators to acknowledge the divergence risk before taking it on.

**MigrationDiverged event.** When `allowBranchFromBranch: true` AND a branch with active children is reclaimed, the orchestrator MUST emit `MigrationDiverged` for each child:

```json
{
  "timestamp": "2026-04-26T18:00:00Z",
  "reclaimedBranch": { "branchKey": "feat-add-prefs-PR-A", "reason": "pr-abandoned", "issueId": "AISDLC-247" },
  "divergentChildren": [
    { "branchKey": "feat-prefs-ui-PR-B", "issueId": "AISDLC-249", "lastActivity": "2026-04-26T17:55:00Z" },
    { "branchKey": "feat-prefs-api-PR-C", "issueId": "AISDLC-251", "lastActivity": "2026-04-26T16:30:00Z" }
  ],
  "interpretation": "child branches inherit a migration that no longer exists in any merged code. Their PRs may pass tests but break on merge to main.",
  "recommendation": "operator triage: rebase children onto current dev, accept divergence (children ship their own copy of the parent's migration), or reclaim children and start over."
}
```

**No automated action.** The orchestrator does NOT auto-reclaim divergent children, auto-rebase, or auto-block them at the merge gate. Divergence is informational; the operator decides because each option has tradeoffs the orchestrator cannot judge:

- **Auto-reclaim** would destroy potentially-valid in-flight work without operator consent.
- **Auto-rebase** could surface migration conflicts that are content disputes between the operator and the abandoned-PR's author — neither resolvable by automation.
- **Auto-block at merge gate** delays the merge gate semantics from "is the base current" to "is the migration ancestry consistent" — adds complexity to the gate without clearly better outcomes.

**Surfacing.** `MigrationDiverged` events appear in `_events.jsonl` (§17), the Slack daily digest, and `cli-status --branches` shows a `divergent: true` flag on affected branches. `cli-status --branches --divergent` filters to divergent branches only for fast triage.

**Why this resolution.** The topology guard (default `false`) eliminates the problem for the common case where it doesn't need to exist. The advisory event handles the niche where operators consciously took on the complexity. Together they avoid both the "operators get bitten by an obscure failure mode" trap and the "we wrote complex auto-recovery logic that does the wrong thing in 30% of cases" trap.

### 15.6 Connection string rewriting

The agent sees `DATABASE_URL` (or whatever the application expects) pointing at the branch. The mechanism:

1. The orchestrator reads `upstream.connectionStringEnv` from its own environment to discover the upstream connection string. This is done once at startup; the value is cached for the orchestrator's lifetime and never logged.
2. On stage dispatch, the orchestrator constructs the agent's environment as a copy of its own, then overlays:
   - `injection.targetEnv` = the branch's connection string from `DatabaseBranchHandle`.
   - For each name in `injection.additionalEnvs` (e.g., `PGHOST`, `PGDATABASE`), parse the connection string and inject the corresponding component.
3. The agent process is spawned with this environment. The agent never sees the upstream connection string — only the branch's.
4. If a stage's `databaseAccess: none`, no injection occurs; the agent inherits whatever the orchestrator's environment had, which by convention is a non-functional placeholder for stages that should not touch DB.

**Multi-database support:** when `WorktreePool.spec.databaseBranchPools[]` references multiple pools, each pool injects independently. A pipeline using `primary-postgres` and `analytics-postgres` injects both `DATABASE_URL` and `ANALYTICS_DATABASE_URL` via two pool definitions with distinct `injection.targetEnv` values.

### 15.7 Stage database-access declaration

`Stage.databaseAccess` (§6.3) drives provisioning decisions:

| Value | Behavior |
|---|---|
| `none` | No branch provisioned for this stage's invocation. Env vars not injected. Cheapest. |
| `read` | If the adapter `supportsReadOnlyBranches`, a single shared read-only branch MAY serve multiple worktrees. Connection string injected. |
| `write` | A per-worktree writable branch is required. Branch is provisioned (eagerly or lazily per `lifecycle.createOn`). |
| `migrate` | Same as `write`, plus the orchestrator MUST acquire the merge gate (§10) before stage execution to serialize schema changes against the upstream HEAD. |

A pipeline whose stages all declare `databaseAccess: none` does not need any DatabaseBranchPool — the resource is unused and the adapter is never invoked.

### 15.8 Failure modes and recovery

| Failure | Adapter behavior | Orchestrator behavior |
|---|---|---|
| Adapter API unavailable on `allocate()` | Throw `AdapterUnavailable` | Apply stage's `onFailure` policy. No fallback chain for DB adapters in v1 — branching is too stateful for transparent failover. |
| Migration command fails | N/A (orchestrator runs it) | Reclaim the branch, abort the pipeline run with `MigrationFailed`. |
| Branch quota exhausted (vendor cap reached) | Throw `BranchQuotaExceeded` | Run stale-branch sweep, retry once. If still exhausted, suspend the pipeline run and alert the operator. |
| Connection string leaks into logs | N/A (caller bug) | This is a P0 security incident. Adapters MUST mask credentials in any error returned. |
| Orchestrator crash mid-allocate | Branch may exist orphaned | Stale-branch sweep on next startup reclaims it. |

### 15.9 Recommended config for the dogfood pipeline

The orchestrator's own state lives in SQLite. Most client pipelines we have onboarded use Neon. Reference defaults the implementation SHOULD ship:

```yaml
# Local dev (SQLite)
- name: orchestrator-state
  adapter: sqlite-copy
  upstream:
    connectionStringEnv: ORCHESTRATOR_DB
  injection:
    targetEnv: ORCHESTRATOR_DB
  lifecycle:
    createOn: worktree-allocation
    reclaimOn: worktree-reclaim
  migrations:
    runOnBranchCreate: true
    migrationCommand: 'pnpm orchestrator:migrate'

# Production client (Neon)
- name: primary-postgres
  adapter: neon
  upstream:
    connectionStringEnv: DATABASE_URL_DEV
    branchFrom: dev
  injection:
    targetEnv: DATABASE_URL
  lifecycle:
    createOn: worktree-allocation
    reclaimOn: pr-merge
    maxConcurrent: 10
    branchTtl: P14D
  migrations:
    runOnBranchCreate: true
    migrationCommand: 'pnpm db:migrate'
  credentials:
    apiTokenEnv: NEON_API_TOKEN
    projectId: prj_dogfood
```

Per-stage defaults:

| Stage | `databaseAccess` |
|---|---|
| `triage` | `none` |
| `review-classify` | `none` |
| `plan` | `read` (browse schema, don't write) |
| `implement` | `write` (most stages need to add migrations or seed data for tests) |
| `validate` | `write` (runs the test suite, which writes) |
| `review-*` | `none` (review reads code diffs, not DB) |
| `simplify` | `read` |
| `fix-pr` | `write` |

## 16. Artifact Directory Convention

### 16.1 Layout

Every stage that produces a consumed-by-downstream artifact writes TWO files: a human-narrative `.md` and a schema-conformant `.json`. Operators read the markdown; downstream stages parse the JSON. See §16.4 for the schema contract.

```
$ARTIFACTS_DIR/<issue-id>/
├── runtime.json          # ports, worktree path, resolved model, resolved harness (incl. fallback used), database branch keys (NOT connection strings), start time
├── plan.md               # human-narrative
├── plan.json             # schema-conformant; consumed by implement stage
├── implementation.md     # human-narrative
├── implementation.json   # schema-conformant; consumed by validate, review-classify, review-* stages
├── validation.md         # human-narrative
├── validation.json       # schema-conformant; consumed by review-* and merge-gate stages
├── review/
│   ├── classifier.json   # output of review-classifier stage (§12); already schema-conformant by design
│   ├── testing.md
│   ├── testing.json      # schema-conformant verdict + findings
│   ├── critic.md
│   ├── critic.json
│   ├── security.md
│   └── security.json
├── pr.json               # PR number, URL, base SHA, head SHA at PR creation
└── state.json            # current stage, started_at, last_heartbeat, status
```

### 16.2 Heartbeats

Each parallel branch MUST update `state.json` at minimum every 60 seconds while a stage is executing. Stale `state.json` (no update for > 5 minutes) signals the operator that the agent has likely hung.

### 16.3 Resumability

Pipeline reconciliation MAY resume an interrupted run by reading `$ARTIFACTS_DIR/<issue-id>/state.json` and re-entering at the recorded stage. Stages MUST be idempotent against artifact replay.

### 16.4 Schema-conformant artifacts

The contract between stages is the JSON file, not the markdown. Markdown is for operators; JSON is for the orchestrator and downstream stages. This separation lets each adapter produce harness-natural narrative for human consumption while guaranteeing a uniform machine-readable surface for automation.

**Schema location.** Each artifact type's JSON Schema lives at `spec/schemas/artifacts/<artifact-name>.schema.json`. v1 ships:

- `plan.schema.json` — proposed approach, files-to-touch, test strategy, expected difficulty, open questions
- `implementation.schema.json` — files modified (with diff stats), commands run, tests added/changed, summary, deviations from plan
- `validation.schema.json` — test results (counts + failure detail), build status, lint/type-check results, manual checks performed
- `review.schema.json` — verdict (`approve` | `approve-with-suggestions` | `request-changes`), findings (severity, file, line range, description, suggestion), summary
- `pr.schema.json` — PR number, URL, base SHA, head SHA, branch name, title, draft status

Every JSON artifact MUST include a `$schema` field naming the schema URI it conforms to (e.g., `"$schema": "spec/schemas/artifacts/implementation.schema.json#v1"`). Schema versioning lets downstream stages declare which version they expect and gives us a forward-compat path when schemas evolve.

**Adapter contract.** Each HarnessAdapter (§13) MUST:

1. Include the relevant schema in its invocation prompt (read from `spec/schemas/artifacts/`) so the harness produces conformant JSON in one shot.
2. Write the JSON file atomically (write to `<file>.tmp`, then `rename` — partial writes MUST NOT be visible to downstream).
3. Validate the produced JSON against the schema before declaring stage success.
4. On validation failure: retry once with a sharpened prompt that includes the schema-validator's error message. If the retry also fails, the stage fails with `ArtifactSchemaInvalid` and the orchestrator applies the stage's `onFailure` policy.

**Markdown is unconstrained.** Adapters MAY produce any markdown structure. Cross-harness review (Codex critiquing Claude's PR) reads the JSON, not the markdown. Operators reading both styles is acceptable variation; downstream automation reading both styles is not.

**Schema evolution.** When a schema needs a breaking change, ship `<artifact>.schema.json#v2` alongside v1. Downstream stages consume whichever version they declare. Adapters MAY produce either; operators control the schema version per pipeline via `Pipeline.spec.artifactSchemaVersion: v1 | v2 | latest`. Default `v1` until the migration window closes.

**Audit trail.** When an adapter's first attempt produces invalid JSON and the retry succeeds, the orchestrator MUST emit an `ArtifactSchemaRetry` event recording the validator error from the first attempt and the resolved JSON from the retry. Persistent retries on the same adapter signal a prompt-template bug; the event stream surfaces this for maintainer triage.

## 17. Observability Requirements

Implementations MUST expose:

1. A read-only view of all active `$ARTIFACTS_DIR/*/state.json` files (e.g., a `cli-status` command summarizing N parallel branches in one screen).
2. A structured event stream (`$ARTIFACTS_DIR/_events.jsonl`) recording stage transitions across all parallel branches, suitable for tailing or piping to a future dashboard.
3. Per-branch terminal access. Operators MUST be able to attach to any single agent's session for debugging. The mechanism (tmux, screen, log tail) is implementation-defined.
4. A real-time burn-down view for each harness's SubscriptionLedger (§14.4): current window utilization, projected end-of-window utilization, queue depth, and pacing recommendation. Implementations SHOULD ship a `cli-status --subscriptions` view that summarizes one row per harness.
5. Per-stage cost-vs-estimate variance reporting. When observed token consumption deviates from `estimatedTokens` by > 50%, the orchestrator MUST log a `EstimateVariance` event. Persistent variance signals stale rolling estimates or a model/prompt change worth investigating.
6. A read-only view of all active database branches per pool: branch key, age, upstream, last-activity timestamp, owning worktree. Implementations SHOULD ship `cli-status --branches` for this view. Branch *connection strings* MUST NEVER appear in any observability output — only branch keys and metadata.

The Slack integration described in `project_slack_integration.md` is a candidate consumer of `_events.jsonl` and the burn-down stream — operators get a daily "you used 73% of your subscription this week" message with a link to under-pacing recommendations.

## 18. Backward Compatibility

- All new fields are optional. Pipelines that omit `parallelism` execute serially as today.
- `Pipeline.spec.parallelism.maxConcurrent` is now optional (was MUST in v1 of this RFC). Omitting it falls through to the tier-aware default (§9.1). Pipelines that explicitly set `maxConcurrent` are unaffected.
- Pipelines that declare `parallelism` but no `SubscriptionPlan` resolve to `maxConcurrent: 1`, which is functionally equivalent to omitting `parallelism` entirely. This is intentional — opt-in to parallelism requires opt-in to a SubscriptionPlan, the same signal that says "I want subscription utilization to be maximized."
- The RFC-0004 `costBudget` semantics are clarified, not changed: it has always been pipeline-scoped dollar-denominated; the v7 amendment makes explicit that subscription-harness work within quota does NOT decrement it (such work is pre-paid). Existing pipelines that set `costBudget` and ran on pay-per-token harnesses continue to behave identically. Pipelines that newly adopt subscription harnesses will see lower `costBudget` consumption than they would under a naive interpretation — this is the correct behavior, but operators should be informed so they don't reduce `costBudget` below the spillover headroom they need.
- The default value of `Stage.isolation` when `parallelism` is unset is `inplace`, preserving current behavior.
- Existing reference implementations MUST continue to validate against the amended schema without modification.
- `WorktreePool` is a new resource; absence is equivalent to "no pooled execution available" and pipelines requesting `parallelism > 1` without a pool MUST fail validation with a clear error.
- The new `Stage.model` field defaults to `inherit`, which resolves to `Pipeline.spec.defaultModel`, which defaults to `sonnet` — matching the current hardcoded behavior. Existing pipelines and agent skills that omit `model` continue to run on Sonnet.
- The `kind` field defaults to `agent`, preserving today's stage semantics. The new `review-classifier` and `review-fanout` kinds are only active when explicitly declared.
- `RFC-0004` cost-attribution amendment is additive: the new `modelId` column on cost ledger entries does not break existing readers; existing aggregation queries continue to work and may be updated to group by it.
- The new `Stage.harness` field defaults to `inherit`, which resolves to `Pipeline.spec.defaultHarness`, which defaults to `claude-code` — matching the only harness used today. Existing pipelines and skills that omit `harness` continue to run on Claude Code with no behavior change.
- The HarnessAdapter interface is internal to the orchestrator. External-facing pipeline YAML only references harnesses by name; the adapter implementation can evolve without schema changes.
- The new `Stage.schedule` field defaults to `now`, preserving today's "dispatch immediately" behavior. Pipelines that omit `schedule` are unaffected by subscription-aware scheduling.
- `SubscriptionPlan` is a new resource; absence is equivalent to `billingMode: pay-per-token` with no quota — preserves today's behavior of "dispatch as fast as the orchestrator can manage."
- The SubscriptionLedger is queried but not enforced when no `SubscriptionPlan` references a harness. Operators opt in by declaring a plan; nothing forces them to.
- The new `Stage.databaseAccess` field defaults to `none`, preserving today's behavior of "agent inherits orchestrator's environment, no branch creation." Pipelines that omit `databaseAccess` continue to share a single DB exactly as today, which is correct for `parallelism: 1` runs.
- `DatabaseBranchPool` is a new resource; absence is equivalent to "no DB isolation available." A pipeline that runs with `parallelism > 1` AND has any stage with `databaseAccess` other than `none` AND no DatabaseBranchPool MUST fail validation at pipeline-load with `DatabaseIsolationRequired`. This fails fast rather than silently corrupting shared state.
- Existing `WorktreePool` declarations without `databaseBranchPools[]` continue to validate. The field is optional; absence equals "no DB isolation infrastructure attached to this pool."

## 19. Implementation Plan

Phased delivery to land low-risk wins first.

### Phase 1 — Foundations (1 week)

- [ ] Implement deterministic port allocator as a standalone function in `orchestrator/src/runtime/port-allocator.ts` with unit tests covering distribution and collision-probe behavior.
- [ ] Implement worktree slug normalization + ownership verification in `orchestrator/src/runtime/worktree.ts` with unit tests against a fixture repo.
- [ ] Add JSON schema validation for the new `Pipeline.spec.parallelism` and `WorktreePool` resource.

### Phase 2 — Pool manager (1–2 weeks)

- [ ] Implement `WorktreePoolManager` (`orchestrator/src/runtime/worktree-pool.ts`): allocate, adopt, reclaim, with the cleanup-on-merge hook.
- [ ] Wire the manager into `execute.ts` behind a feature flag (`AI_SDLC_PARALLELISM=experimental`).
- [ ] Integration test: dispatch 3 issues against a fixture repo, verify isolated worktrees + distinct ports + clean reclamation.

### Phase 2.5 — Per-stage model routing (1 week, parallelizable with Phase 2)

- [ ] Add `Stage.model`, `Stage.kind`, `Stage.maxBudgetUsd`, and `Pipeline.spec.defaultModel` to the JSON schemas.
- [ ] Implement the model-alias registry (`orchestrator/src/models/registry.ts`) and resolution function with unit tests.
- [ ] Update `ai-sdlc-plugin/agents/{code,test,security}-reviewer.md` frontmatter to use `model: inherit` instead of hardcoded `sonnet`.
- [ ] Update the `triage` skill to declare `model: haiku`.
- [ ] Amend `orchestrator/src/cost-governance.ts` to record `modelId` per stage entry; update aggregation queries.
- [ ] Implement `review-classifier` stage kind with the default rules from §12.3.
- [ ] Implement `review-fanout` stage kind that reads `classifier.json` and dispatches selected reviewers in parallel.
- [ ] Integration test: a docs-only PR runs only the critic reviewer; an auth-touching PR runs all three with security bumped to Opus.

### Phase 2.7 — Harness adapter framework + Codex adapter (2 weeks, parallelizable with Phases 2 and 2.5)

- [ ] Implement `HarnessAdapter` interface, registry, and capability matrix at `orchestrator/src/harness/{types.ts, registry.ts}`.
- [ ] Migrate today's hardcoded Claude Code invocation into a `ClaudeCodeAdapter` implementing the interface (no behavior change, just refactor — covered by existing tests).
- [ ] Implement `CodexAdapter` driving the OpenAI Codex CLI; verify it can run against a fixture worktree end-to-end.
- [ ] Add `Stage.harness`, `Stage.harnessFallback`, `Pipeline.spec.defaultHarness`, `Pipeline.spec.defaultHarnessFallback` to the JSON schemas.
- [ ] Implement pipeline-load validation per §13.4 (unknown harness, model unavailable on harness, capability mismatch).
- [ ] Implement runtime fallback per §13.5; integration test that takes Claude Code "offline" via env var and verifies Codex picks up the stage.
- [ ] Update `review-critic` and `review-security` skills to declare `harness: codex` per §11.3 recommended routing.
- [ ] Integration test: end-to-end review where Claude implements and Codex critiques, verify both artifacts land in `$ARTIFACTS_DIR`.
- [ ] Document the adapter-authoring guide for future `gemini-cli` / `opencode` / `aider` / `generic-api` adapters; do NOT ship those adapters in v1.

### Phase 2.8 — Subscription-aware scheduling (2 weeks, sequenced after Phase 2.7)

- [ ] Implement `SubscriptionLedger` interface and persistent state at `orchestrator/src/scheduling/{ledger.ts, types.ts}` with file-backed `$ARTIFACTS_DIR/_ledger/` storage.
- [ ] Implement `SubscriptionPlan` resource validation; ship reference plans for `claude-code-pro`, `claude-code-max-5x`, `claude-code-max-20x`, `codex-plus`, `codex-pro`, `pay-per-token` at `spec/examples/subscription-plans/`.
- [ ] Implement off-peak schedule evaluation with timezone-aware time-range matching. Unit tests against fixture clocks.
- [ ] Add `Stage.schedule` and `Stage.estimatedTokens` to JSON schemas.
- [ ] Implement schedule-aware dispatcher: queue ordering by PPA × schedule × ledger admission. Unit tests covering the four schedule modes.
- [ ] Implement burn-down report emitter (every 5 min, configurable) and `cli-status --subscriptions` view.
- [ ] Implement rolling per-stage token-estimate calibration; tests for variance detection.
- [ ] Integration test: 20-issue queue with mixed PPA scores and schedule hints, fixture clock advancing through peak→off-peak transitions, verify off-peak issues defer correctly and burn-down recommendations match expected.
- [ ] Document operator runbook: how to declare a SubscriptionPlan, how to read burn-down reports, what to do when `under-pacing` vs `over-pacing` recommendations fire.

### Phase 3 — Concurrency + merge gate (1–2 weeks)

- [ ] Convert `execute.ts` from single-issue to a worker-pool model bounded by `parallelism.maxConcurrent`.
- [ ] Implement the file-based merge gate with stale-base detection and rebase-on-conflict.
- [ ] Integration test: 5 concurrent issues, deliberately overlapping touched files, verify all PRs land mergeable.

### Phase 4 — Artifacts + observability (1 week)

- [ ] Define the artifact directory schema and migrate existing review outputs to the new layout.
- [ ] Implement heartbeat writer in the agent harness.
- [ ] Add a `cli-status --all` view that summarizes every active branch.
- [ ] Emit `_events.jsonl` for the Slack integration to subscribe to in a follow-up.

### Phase 5 — Hardening (1 week)

- [ ] Chaos test: kill agents mid-stage, verify reclamation + resumability.
- [ ] Document operator runbook for `WorktreeOwnershipMismatch`, `RebaseConflict`, and stuck heartbeats.
- [ ] Promote the feature flag to default-on after one week of dogfood stability.

### Phase 6 — Database isolation (3 weeks, sequenced after Phase 3)

Sequenced after the merge gate (Phase 3) because the `migrate` access mode requires the merge gate to serialize schema changes against upstream HEAD.

- [ ] Implement `DatabaseBranchAdapter` interface, registry, capability matrix at `orchestrator/src/database/{types.ts, registry.ts}`.
- [ ] Implement `SqliteCopyAdapter` (~2 days). File copy on allocate, optional hardlink for read-only branches, delete on reclaim. Integration test with a fixture SQLite database and 3 parallel worktrees.
- [ ] Implement `NeonAdapter` (~5 days). Wraps Neon REST API for branch create/delete/list. Uses `NEON_API_TOKEN`. Integration test against a real Neon project (a sandbox project the dogfood pipeline owns).
- [ ] Implement `PgSnapshotRestoreAdapter` (~5 days). `pg_dump` + `pg_restore` flow for vanilla Postgres; `aws rds restore-db-instance-from-db-snapshot` for AWS RDS. Integration test against a local Postgres in CI.
- [ ] Implement `ExternalAdapter` (~1 day). Operator-declared shell hooks. Pipeline-load validation requires `acknowledgeUntrusted: true`.
- [ ] Add `Stage.databaseAccess`, `DatabaseBranchPool` resource, `WorktreePool.spec.databaseBranchPools[]` to JSON schemas.
- [ ] Implement connection-string injection (env-var rewriting) in the agent dispatch path. Unit tests for parsing connection strings into component env vars.
- [ ] Implement migration coordination: run `migrationCommand` against newly-allocated branch; surface failure as `MigrationFailed`; integration with merge gate for `databaseAccess: migrate` stages.
- [ ] Implement stale-branch sweep at orchestrator startup; respects `branchTtl` and `abandonAfter`.
- [ ] Implement `cli-status --branches` view.
- [ ] Security review: confirm connection strings never appear in `state.json`, event stream, logs, or error messages. Static-analysis check on adapter code for accidental log leaks.
- [ ] Document operator runbook for `BranchQuotaExceeded`, `MigrationConflict`, `MigrationFailed`, and orphan-branch cleanup.
- [ ] Integration test: 5 parallel worktrees against Neon, each adding a different migration, verify isolation and that merged migrations apply cleanly to subsequent branches.
- [ ] Migrate the dogfood pipeline's orchestrator-state SQLite to use `sqlite-copy` adapter; verify no regressions.
- [ ] Implement warm pool per §15.4.1 (allocate-on-startup, async refill, single-use after reclaim, stale-drain on upstream migrations). Default `warmPoolSize: 0` so opt-in only. Integration test exercises `warmPoolSize: 3` against a fixture Neon project, verifies sub-100ms dispatch latency and correct refill behavior. The path ships tested even if nobody enables it in production.

## 20. Alternatives Considered

### 20.1 Adopt Archon directly

We could deploy Archon as our orchestrator instead of extending our own. **Rejected** because Archon is a standalone server that runs Claude Code as a subprocess; we are a Claude Code plugin and operate inside the harness, not outside it. The architectural mismatch is too costly to bridge. We borrow patterns instead.

### 20.2 Container-per-agent isolation

Use Docker containers (one per issue) instead of git worktrees. **Rejected for v1** because it adds a Docker dependency to the dogfood pipeline and an order-of-magnitude longer cold-start (image build, volume mount). Worktrees give us the isolation we need at near-zero startup cost. Container isolation may revisit if we move to multi-host execution.

### 20.3 Central port broker

Run a daemon that allocates ports on request. **Rejected** because the deterministic-hash function is simpler, requires no daemon lifecycle, and Archon's production usage validates the approach. The 6% collision probability at our cap is acceptable given the probe fallback.

### 20.4 Optimistic merge (parallel push)

Let all PRs push in parallel and let GitHub serialize via `update-branch`. **Rejected** because GitHub's `update-branch` uses merge commits, violating the project's rebase-only policy (`feedback_rebase_not_merge.md`). The explicit merge gate gives us rebase semantics under our own control.

### 20.5 Adaptive model selection from the outset

Have the orchestrator choose the model per stage based on diff size, file types, and historical cost/quality signals. **Rejected for v1** because we lack the cost/quality telemetry to train a useful selector. Declarative routing now generates the per-stage cost ledger that adaptive selection would later need; this is a deliberate sequencing decision, not a permanent rejection.

### 20.6 One reviewer agent that decides everything internally

Replace the three reviewer agents with a single agent that does its own scoping. **Rejected** because losing the bias-isolation property of independent reviewers (each in a fresh context) erodes the review quality argument from the Archon transcript and from RFC-0008's review composite. The classifier-then-fanout pattern keeps reviewer independence intact while skipping unneeded ones.

### 20.7 Single-harness pipeline (Claude Code only)

Continue assuming Claude Code is the only harness, optimize for its specific capabilities, accept the lock-in. **Rejected** for the four risks enumerated in §2.7: vendor concentration, lost cost arbitrage, lost cross-harness review independence, and inability to route stages to the harness with the right strengths. The cost of the adapter framework (~2 weeks per Phase 2.7) is amortized across every future harness we add and every client deployment that needs harness flexibility for credential or vendor reasons.

### 20.8 Plugin/extension model for third-party adapters

Allow third parties to ship harness adapters as separately-installable plugins. **Rejected for v1** because adapters execute external CLIs with full credential scope — running an unreviewed adapter is equivalent to running an unreviewed credential-stealing daemon. Maintainer-reviewed in-tree adapters only, until we have a meaningful sandboxing story (which is a non-trivial future RFC of its own).

### 20.9 Optimize for unit cost rather than subscription utility

Continue treating each call as pay-per-token and optimize for minimum cost per issue. **Rejected** because it ignores how clients actually pay. A pipeline optimized for unit cost will be tempted to skip stages, downgrade models, or reduce review coverage to "save money" — but those savings are imaginary when the subscription has already been paid and the saved tokens evaporate at window-end. Subscription utility is the correct objective function for the dominant billing mode (Claude Code Pro/Max).

### 20.10 Defer all subscription-aware logic to a separate scheduler service

Build the SubscriptionLedger as a standalone daemon that the orchestrator queries via RPC. **Rejected for v1** because the ledger needs tight integration with stage dispatch, harness fallback, and queue ordering — RPC overhead and split-brain failure modes between two processes outweigh the modularity benefits at our current scale. The interface defined in §14.2 is RPC-friendly if we ever need to extract it.

### 20.11 Defer database isolation to RFC-0011

What v4 of this RFC said: ship parallel execution now, ship DB isolation later. **Rejected after CTO direction** because every onboarded client is on Postgres and would be stuck at `parallelism: 1` until RFC-0011 lands. The marginal cost of including DB isolation in this RFC (Phase 6, ~3 weeks, +400 lines of spec) is small compared to the value of shipping a complete parallel-execution story.

### 20.12 Use schema-per-tenant inside a single database instead of branches

Instead of provisioning separate database branches, give each worktree a separate schema in a shared database. **Rejected** because: (a) it requires application code changes to use the right schema, breaking the "agent transparently uses DATABASE_URL" property; (b) shared connection pools can leak across schemas if pooling configuration is wrong; (c) it doesn't isolate database-level state like sequences, extensions, or settings; (d) reclamation requires `DROP SCHEMA CASCADE` which is destructive enough that bugs cause production incidents. Branches are cleaner.

### 20.13 Wrap every test in a transaction that rolls back

Common pattern in test frameworks: each test runs in a transaction, no commits actually persist, the next test sees a clean DB. **Rejected as the primary mechanism** because: (a) it doesn't work for the agent's own iterative development (the agent inserts a row, queries it back, expects to see it across processes); (b) it doesn't isolate migrations; (c) it requires application/test cooperation we cannot assume across all client codebases. Branches don't require any application changes. Test-transaction-rollback remains a valid *complement* to branches inside a single agent's test suite.

## 21. Open Questions

All 16 open questions raised during the v1 draft and walkthrough (the original Q1 about per-worktree DB isolation, then Q1–Q15 in the post-v6 renumbering) have been resolved through normative additions in v5–v20. See the revision history (top of document) for the resolution of each.

The walkthrough that produced these resolutions is preserved as design rationale; the resolutions themselves are normative and live in the relevant sections (§9.1, §9.4, §11.6, §12.2/§12.3, §13.4/§13.8/§13.10, §14.5/§14.6/§14.10/§14.11/§14.12/§14.13, §15.4.1/§15.5.1).

**New questions discovered during implementation MAY be added back to this section.** A frozen list of "all resolved" is not a stable equilibrium for a living spec; new failure modes will surface during Phase 1–6 build-out and operator-trial deployment. Track them here as they emerge.

## 22. References

- **Prior art:** `coleam00/Archon` (`packages/git/src/worktree.ts`, `packages/core/src/utils/port-allocation.ts`, `packages/isolation/src/resolver.ts`, `.archon/workflows/defaults/archon-fix-github-issue.yaml`). Specifically borrows the deterministic port-hash, the cross-clone ownership guard, and the artifact-directory convention.
- **Companion talk:** "Parallel Agentic Development" by Cole Medin (2026). The accompanying `w.sh`/`.ps1` worktree-setup scripts referenced in the talk are NOT in the Archon repo and were independently re-derived for this RFC.
- **Internal specs:** RFC-0002 (Pipeline Orchestration), RFC-0004 (Cost Governance and Attribution), RFC-0008 (PPA Triad Integration).
- **Internal code touched by this RFC:** `orchestrator/src/execute.ts` (single-issue → worker-pool migration; harness- and schedule-aware dispatch), `orchestrator/src/cost-governance.ts` (modelId + harnessId columns; ledger integration), `orchestrator/src/review-runner.ts` (classifier integration), `orchestrator/src/harness/{types.ts, registry.ts, adapters/{claude-code,codex}.ts}` (NEW — adapter framework), `orchestrator/src/scheduling/{ledger.ts, types.ts, off-peak.ts}` (NEW — SubscriptionLedger + scheduler), `ai-sdlc-plugin/agents/{code,test,security}-reviewer.md` (model: inherit; security & critic move to `harness: codex`), `ai-sdlc-plugin/commands/triage.md` (model: haiku), `ai-sdlc-plugin/commands/review.md` (classifier-aware fan-out, harness-aware dispatch), `spec/examples/subscription-plans/*.yaml` (NEW — reference plans for common tiers).
- **External billing documentation:** Claude Code Pro/Max plan limits and off-peak schedule (`docs.claude.com/claude-code/billing` — operator MUST verify against current docs when declaring SubscriptionPlans), OpenAI Codex Plus/Pro monthly cap details (`platform.openai.com/docs/codex`). The off-peak multiplier value (~2×) and exact window hours are subject to vendor change; SubscriptionPlans MUST be updated when vendor terms change.
- **External database-branching documentation:** Neon branching API (`neon.tech/docs/manage/branches`), Supabase branching (`supabase.com/docs/guides/platform/branching`), AWS RDS snapshot/restore (`docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateSnapshot.html`). Adapter implementations MUST cite the upstream API version they target.
- **Database isolation code added:** `orchestrator/src/database/{types.ts, registry.ts, adapters/{sqlite-copy,neon,pg-snapshot-restore,external}.ts}` (NEW), connection-string injection in agent dispatch path, `cli-status --branches` command, stale-branch sweep on orchestrator startup, `spec/examples/database-branch-pools/*.yaml` (NEW — reference pool definitions for SQLite, Neon, RDS).
- **External harness documentation:** Claude Code (`claude.com/claude-code`), OpenAI Codex CLI (`github.com/openai/codex`), Gemini CLI (`github.com/google-gemini/gemini-cli`), OpenCode (`github.com/sst/opencode`), Aider (`aider.chat`), OpenRouter (`openrouter.ai`). Adapter implementations MUST cite the upstream version they target.
- **Prior art on multi-harness orchestration:** Archon's `packages/providers/src/registry.ts` (claude / codex / community providers) demonstrates the registry pattern at production scale. Their `pi-coding-agent` provider exposes ~20 LLMs through a single harness — useful inspiration for the future `generic-api` adapter.
- **Project memories incorporated:** `feedback_observability.md` (real-time visibility), `feedback_never_merge_prs.md` (merge gate ≠ auto-merge), `feedback_rebase_not_merge.md` (rejects GitHub `update-branch`), `feedback_review_severity_policy.md` (classifier preserves severity rules), `project_dogfood_pipeline_vision.md` (overall framing), `project_slack_integration.md` (event stream consumer).
