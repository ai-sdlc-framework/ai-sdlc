# Operations Runbooks

Operator-facing runbooks for running, tuning, and triaging an AI-SDLC pipeline in production. These docs assume you have already run `ai-sdlc init` — see [`init.md`](init.md) if you haven't.

---

## Navigation Map

### Governance

| Runbook | Description |
|---------|-------------|
| [`system-of-record.md`](system-of-record.md) | Which store wins per artifact (task, issue, PR, decision, RFC, board, attestation, memory) and where this project diverges from playbook human-approval stages |
| [`decision-authority.md`](decision-authority.md) | The autonomous decision protocol: classes (a), (b) and (c) |

---

### Autonomous Orchestrator

The orchestrator runs a continuous reconciliation loop over your backlog, dispatching tasks into isolated worktrees and running the full Step 0-13 pipeline autonomously.

| Runbook | Description |
|---------|-------------|
| [`claude-cli-spawner-removed.md`](claude-cli-spawner-removed.md) | RFC-0041 Phase 3.3 (AISDLC-377.6) removal of the `--spawner claude-cli` inline-manifest path — migration breadcrumb for legacy scripts |

**RFC:** [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md)

---

### Session Hierarchy

A planner, a dispatch session and up to five executors, each in its own tmux session, started and managed with `cli-hierarchy`.

| Runbook | Description |
|---------|-------------|
| [`session-hierarchy.md`](session-hierarchy.md) | Operator runbook: the three tiers, starting and stopping, roster, board and sequence groups, escalation chain and timeboxes, context clearing, permission modes, governance values, troubleshooting |
| [`cli-hierarchy.md`](cli-hierarchy.md) | `cli-hierarchy` reference: all subcommands (including `demo`, which regenerates the terminal demo clip) and the `up` options, roster file, operating cycle (brief, tick, clear), restart rule, troubleshooting |

**RFC:** [`spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`](../../spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md)

---

### Cross-Harness Review

Claude and Codex review each other's work. Bidirectional coverage with harness-tagged DSSE envelopes and independence enforcement.

| Runbook | Description |
|---------|-------------|
| [`cross-harness-review.md`](cross-harness-review.md) | Full bidirectional convention, Codex CLI prerequisites, security architecture, cost comparison, pilot procedure, and results log |
| [`codex-execution-path.md`](codex-execution-path.md) | Wire protocol for `--spawner codex` programmatic dispatch via the `CodexHarnessAdapter` |
| [`codex-completion.md`](codex-completion.md) | Codex completion path reference |

**RFC:** [`spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md`](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) §13

---

### Staged Review

A review pipeline that plans, probes and synthesizes, run in shadow beside the gating reviewers until the comparison bar is met.

| Runbook | Description |
|---------|-------------|
| [`staged-review.md`](staged-review.md) | Stages, baseline checklist, schemas, `staged.*` config, routing cells, shadow comparison, replay, the two switches, attestation leaves, troubleshooting |

**RFC:** [`spec/rfcs/RFC-0052-staged-review-pipeline.md`](../../spec/rfcs/RFC-0052-staged-review-pipeline.md)

---

### Dependency Graph Composition

Blast-radius analysis and DoR gating based on codebase dependency snapshots.

| Runbook | Description |
|---------|-------------|
| [`deps-composition.md`](deps-composition.md) | `cli-deps snapshot/gc/inspect`, Phase 1-5 feature flag surfaces |
| [`deps-composition-promotion.md`](deps-composition-promotion.md) | Hybrid promotion runbook to flip `AI_SDLC_DEPS_COMPOSITION` default-on |

**Feature flag:** `AI_SDLC_DEPS_COMPOSITION`

**RFC:** [`spec/rfcs/RFC-0014-dependency-graph-composition.md`](../../spec/rfcs/RFC-0014-dependency-graph-composition.md)

---

### Definition of Ready (DoR) Gate

Admission filter that ensures tasks are properly specified before agent dispatch.

| Runbook | Description |
|---------|-------------|
| [`dor-promotion.md`](dor-promotion.md) | Corpus path vs. override path for flipping `evaluationMode: warn-only → enforce` |

**RFC:** [`spec/rfcs/RFC-0011-definition-of-ready-gate.md`](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md)

### Judgment Layer

| Runbook | Description |
|---------|-------------|
| [`judgment-layer.md`](judgment-layer.md) | Operator runbook and adopter guide: enabling, providers (`jev`, `openai-compatible`), egress classes, modes, downgrade reasons, log, cost, kill switch, troubleshooting (RFC-0049) |
| [`judgment-promotion.md`](judgment-promotion.md) | Corpus path vs. override path for flipping a judgment from `shadow` to `enforce`, per `riskClass` |
| [`judgment-definitions.md`](judgment-definitions.md) | Registration-time safety rules for judgment definitions (`fallback`, `reducesReview`, `reducingOutcomes`) |

---

### Signal Ingestion Pipeline

Pluggable adapters fetch raw customer signals (support tickets, community threads, manual entries), classify them by tier + ICP + recency, cluster them into demand themes, filter through SA resonance, and feed cluster-level demand into PPA D1.

| Runbook | Description |
|---------|-------------|
| [`signal-ingestion.md`](signal-ingestion.md) | Operator runbook — adapter setup, tier-multiplier tuning, SA-resonance threshold calibration, flooding-detection sensitivity, manual signal entry, governance-event audit |

**Feature flag:** `AI_SDLC_SIGNAL_INGESTION` (off — soak window)

**RFC:** [`spec/rfcs/RFC-0030-signal-ingestion-pipeline.md`](../../spec/rfcs/RFC-0030-signal-ingestion-pipeline.md)

**Schema:** [`spec/schemas/signal-ingestion-config.v1.schema.json`](../../spec/schemas/signal-ingestion-config.v1.schema.json)

---

### Quality Gates and CI

| Runbook | Description |
|---------|-------------|
| [`quality-gate.md`](quality-gate.md) | `ai-sdlc/pr-ready` single rollup check — archetype gating, cutover, and rollback |
| [`merge-queue-rebase-recovery.md`](merge-queue-rebase-recovery.md) | Recovering from merge-queue rebases that invalidate DSSE attestation envelopes (`contentHashV4`) |
| [`pr-unstick.md`](pr-unstick.md) | Unsticking PRs blocked by stale checks, failed merge queue, or attestation issues |

---

### Bootstrapping and Init

| Runbook | Description |
|---------|-------------|
| [`init.md`](init.md) | `ai-sdlc init` adopter guide — wizard prompts, flags, idempotency, recommended bootstrap sequences |
| [`auto-rebase-token-setup.md`](auto-rebase-token-setup.md) | Setting up the token required for the `/ai-sdlc rebase` automated rebase command |
| [`auto-rebase-stale-prs.md`](auto-rebase-stale-prs.md) | Auto-rebase DIRTY/BEHIND PRs script (Option A — operator re-signs locally); the `auto-rebase-open-prs.yml` workflow it complemented was deleted (AISDLC-727) |

---

### Day-2 Operations

| Runbook | Description |
|---------|-------------|
| [`stacked-prs.md`](stacked-prs.md) | Managing stacked PRs in the merge queue |
| [`adapter-authoring.md`](adapter-authoring.md) | Authoring a new harness adapter (`AgentRunner` / `HarnessAdapter` extension point) |
| [`rollback.md`](rollback.md) | Backing out a defective npm release, a bad plugin version pin, or a bad `main` commit |

---

### Usage and Model Routing

Token usage per model call, plan allotment tracking, and evidence-based choice of models per agent role.

| Runbook | Description |
|---------|-------------|
| [`usage-ledger.md`](usage-ledger.md) | The machine-level usage ledger: what is recorded, ingestion, `cli-usage` reports and views, weighted units, allotment snapshots, price feed, troubleshooting |
| [`model-routing.md`](model-routing.md) | The routing table, resolver order, exploration, assignment log, scorecards, reviewer replay, and the planned weekly proposal rules |

**RFC:** [`spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`](../../spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md)

### Agent Memory

| Runbook | Description |
|---------|-------------|
| [`memory-dream.md`](memory-dream.md) | Consolidate, prune and refine the memory folder: run, review the report, apply, undo, memory guidance |

---

### Design System (if applicable)

| Runbook | Description |
|---------|-------------|
| [`design-system-operator-runbook.md`](design-system-operator-runbook.md) | Design system governance pipeline operations |

---

## Quick Reference

### Feature Flags

| Flag | Default | Gates |
|------|---------|-------|
| `AI_SDLC_DEPS_COMPOSITION` | off | Dependency graph composition (`cli-deps snapshot/gc/inspect`) |
| `AI_SDLC_DOR_GATE` | warn-only | Definition of Ready admission gate |
| `AI_SDLC_SIGNAL_INGESTION` | off | RFC-0030 signal ingestion pipeline (composes with `.ai-sdlc/signal-ingestion.yaml` `spec.enabled`) |

Canonical truthy values for all flags: `1`, `true`, `yes`, `on` (case-insensitive).

### Key CLI Commands

```bash
# Autonomous orchestrator
node pipeline-cli/bin/cli-orchestrator.mjs tick       # single tick
node pipeline-cli/bin/cli-orchestrator.mjs start      # continuous loop
node pipeline-cli/bin/cli-orchestrator.mjs status     # current state

# Dependency graph
node pipeline-cli/bin/cli-deps.mjs snapshot
node pipeline-cli/bin/cli-deps.mjs frontier --format table

# Attestation verification
node pipeline-cli/bin/cli-verify-attestation.mjs

# Health check
ai-sdlc health
```

### Events Observability

Orchestrator events are written to `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl`:

```bash
# Stream live events
tail -f artifacts/_orchestrator/events-$(date +%Y-%m-%d).jsonl | jq .

# Find quarantined work
jq -c 'select(.type == "OrchestratorWorkQuarantined")' artifacts/_orchestrator/events-*.jsonl

# Find recoverable aborts
jq -c 'select(.type == "OrchestratorTaskAbortedRecoverable")' artifacts/_orchestrator/events-*.jsonl

# Find blocked tasks
jq -c 'select(.type == "TaskBlocked")' artifacts/_orchestrator/events-*.jsonl
```

---

## Archived / Superseded

Runbooks that described behavior now superseded by shipped work are noted here rather than deleted, to preserve their historical context.

| Document | Status | Superseded by |
|----------|--------|---------------|
| _(none currently)_ | | |

If you encounter documentation that references early-RFC draft behavior no longer matching the shipped implementation, open a backlog task referencing `docs/operations/` to flag the drift.
