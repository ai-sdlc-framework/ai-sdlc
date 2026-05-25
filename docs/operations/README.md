# Operations Runbooks

Operator-facing runbooks for running, tuning, and triaging an AI-SDLC pipeline in production. These docs assume you have already run `ai-sdlc init` — see [`init.md`](init.md) if you haven't.

---

## Navigation Map

### Autonomous Orchestrator

The orchestrator runs a continuous reconciliation loop over your backlog, dispatching tasks into isolated worktrees and running the full Step 0-13 pipeline autonomously.

| Runbook | Description |
|---------|-------------|
| [`orchestrator-runbook.md`](orchestrator-runbook.md) | Day-to-day operations: auto-rebuild, inline mode, in-flight detection, blocking tasks, quarantine recovery, worktree mutex, resume from interrupted runs |
| [`orchestrator-promotion.md`](orchestrator-promotion.md) | Hybrid promotion runbook — soak corpus + spot-check evidence to flip `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` default-on |
| [`orchestrator-inline-loop.md`](orchestrator-inline-loop.md) | Running the orchestrator inline inside a Claude Code session (subscription billing) |

**Feature flag:** `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`

**RFC:** [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md)

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
| [`auto-rebase-stale-prs.md`](auto-rebase-stale-prs.md) | Auto-rebase DIRTY/BEHIND PRs on push-to-main (Option A — operator re-signs locally) |

---

### Day-2 Operations

| Runbook | Description |
|---------|-------------|
| [`operator-runbook.md`](operator-runbook.md) | What the Pipeline Operator role is, daily/weekly/monthly cadence, event triage |
| [`stacked-prs.md`](stacked-prs.md) | Managing stacked PRs in the merge queue |
| [`adapter-authoring.md`](adapter-authoring.md) | Authoring a new harness adapter (`AgentRunner` / `HarnessAdapter` extension point) |
| [`claude-cli-spawner.md`](claude-cli-spawner.md) | Claude CLI spawner option evaluation — inline vs. subprocess vs. API-key billing |

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
| `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` | off | Autonomous orchestrator (`cli-orchestrator tick/start`) |
| `AI_SDLC_DEPS_COMPOSITION` | off | Dependency graph composition (`cli-deps snapshot/gc/inspect`) |
| `AI_SDLC_TUI` | off | Operator TUI dashboard (`cli-tui`) |
| `AI_SDLC_DOR_GATE` | warn-only | Definition of Ready admission gate |

Canonical truthy values for all flags: `1`, `true`, `yes`, `on` (case-insensitive). `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` also accepts `experimental` as the recommended opt-in value.

### Key CLI Commands

```bash
# Autonomous orchestrator
node pipeline-cli/bin/cli-orchestrator.mjs tick       # single tick
node pipeline-cli/bin/cli-orchestrator.mjs start      # continuous loop
node pipeline-cli/bin/cli-orchestrator.mjs status     # current state

# Operator TUI
AI_SDLC_TUI=experimental node pipeline-cli/bin/cli-tui.mjs

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
