<div align="center">

# AI-SDLC Framework

**The Decision Engine for autonomous software development**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/ai-sdlc-framework/ai-sdlc/actions/workflows/ci.yml/badge.svg)](https://github.com/ai-sdlc-framework/ai-sdlc/actions/workflows/ci.yml)
[![Spec Version](https://img.shields.io/badge/spec-v1alpha1-orange.svg)](#specification--versioning)
[![Coverage](https://codecov.io/gh/ai-sdlc-framework/ai-sdlc/branch/main/graph/badge.svg)](https://codecov.io/gh/ai-sdlc-framework/ai-sdlc)
[![Docs](https://img.shields.io/badge/docs-ai--sdlc.io-0a0a0a.svg)](https://ai-sdlc.io/docs)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Website](https://ai-sdlc.io) · [Documentation](https://ai-sdlc.io/docs) · [Specification](https://ai-sdlc.io/docs/spec/spec) · [Getting Started](https://ai-sdlc.io/docs/getting-started) · [Vision](VISION.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What this is

AI-SDLC turns software development into a series of well-framed decisions that the framework executes deterministically. Operators frontload the load-bearing decisions through a Definition-of-Ready gate; an autonomous orchestrator dispatches developer subagents through the dependency graph; cross-harness reviewers (Claude × Codex × …) verify the work in parallel; DSSE attestations seal every change; pull requests open themselves.

The leverage move is **cost asymmetry**: operator decisions made upfront — with full context, time to think, and access to stakeholders — are cheap and (mostly) correct. AI decisions made mid-execution under uncertainty are expensive and often wrong. The framework's value is not "AI writes code"; it's **"AI executes well-specified contracts deterministically."** Those are different products with different reliability profiles.

The operator's role shifts to **decision steward** — frame open questions, resolve them, sign off on resolutions, monitor the pipeline. Typing and rubber-stamping go to the framework.

> **Read first:** [`VISION.md`](VISION.md) is the organizing thesis — the design philosophy that grounds every RFC, every CLI, every gate. If something in this repo doesn't trace back to one of its principles, that's a signal we've drifted.

---

## The problem AI-SDLC solves

AI agents can build small greenfield projects, but software falls apart as it grows. The data is consistent:

- **Productivity paradox** — Experienced developers using AI tools are 19% slower on mature codebases, despite believing they are 20% faster ([METR 2025](https://metr.org))
- **Quality decline** — Refactoring dropped from 25% to 10% of changes; code churn rose from 5.5% to 7.9% ([GitClear 2024](https://www.gitclear.com))
- **Stability regression** — Every 25% increase in AI adoption correlates with a 7.2% drop in system stability ([Google DORA 2024](https://dora.dev))
- **Trust gap** — Only 3% of developers express high trust in AI output ([Stack Overflow 2025](https://survey.stackoverflow.co))

The root cause is not that AI agents write bad code. It is that **nobody orchestrates how they work as the codebase grows** — every decision gets deferred to the worst possible moment, made by the actor with the least context. AI-SDLC flips that.

---

## The five pillars

The framework is one cohesive system, but it ships as five pillars you can adopt incrementally.

### 1. The Decision Engine — [RFC-0011](spec/rfcs/RFC-0011-definition-of-ready-gate.md) · [RFC-0035](spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)

A Definition-of-Ready gate (RFC-0011) refuses to dispatch tasks the operator hasn't actually decided yet. A forthcoming Decision Catalog (RFC-0035, Draft) makes the operator's open-question queue a first-class resource — ranked by leverage, routed to the right actor, surfaced with framework recommendations + counter-arguments + sub-decision graphs. The framework recommends; the operator decides; the orchestrator executes. → [Concept page](https://ai-sdlc.io/docs/concepts/dor-gate)

### 2. Autonomous Pipeline Orchestrator — [RFC-0015](spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md)

`cli-orchestrator tick` walks the dependency graph (RFC-0014), runs admission filters (blocked, in-flight, DoR, dispatchability), dispatches admitted tasks into isolated git worktrees, runs the Step 0-13 pipeline (dev agent → 3 reviewers → attestation sign → PR open), quarantines failures, and resumes from checkpoint commits on interruption. Operators monitor; they don't type. Feature flag: `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`. → [Concept page](https://ai-sdlc.io/docs/concepts/autonomous-orchestrator) · [Runbook](docs/operations/orchestrator-runbook.md)

### 3. Cross-Harness Review — [RFC-0010](spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) §13

Three reviewer subagents run in parallel on every change. DSSE envelopes carry a `harness` field that identifies the execution harness behind each review, and `verify-attestation` enforces **independence by construction**: if Claude implemented, Claude cannot also be the code or test reviewer. Codex reviews Claude's work and vice versa. Reviewer collusion is mechanically impossible. → [Concept page](https://ai-sdlc.io/docs/concepts/cross-harness-review) · [Runbook](docs/operations/cross-harness-review.md)

### 4. Operator TUI — [RFC-0023](spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md)

A live terminal interface with five panes: decisions-pending (RFC-0035), pipeline + PRs, dependency graph, configuration, and analytics. Foregrounds load-bearing decisions and stays out of the way for the rest. → [Concept page](https://ai-sdlc.io/docs/concepts/operator-tui)

### 5. Declarative Governance

Declarative resources for the whole lifecycle: `Pipeline`, `Decision`, `AgentRole`, `QualityGate`, `AutonomyPolicy`, `AdapterBinding` — all with JSON Schema (draft 2020-12) under [`spec/schemas/`](spec/schemas/). Quality gates run advisory → soft-mandatory → hard-mandatory with cross-harness review and DSSE attestation. Adopters declare a compliance posture ([RFC-0022](spec/rfcs/RFC-0022-compliance-posture-audit-surface.md)) and the framework derives gate defaults — EU AI Act, NIST AI RMF, ISO 42001. → [Specification](spec/spec.md)

---

## Quick start

```bash
# 1. Install the Claude Code plugin (recommended)
/plugin marketplace add ai-sdlc-framework/ai-sdlc
/plugin install ai-sdlc@ai-sdlc
/reload-plugins

# 2. Scaffold your repository
ai-sdlc init

# 3. Dispatch your first task
/ai-sdlc execute AISDLC-42
```

Full setup, runner configuration, agent-runner reference, and the autonomous-orchestrator opt-in are in the documentation:

→ [Getting Started](https://ai-sdlc.io/docs/getting-started) · [Tutorials](https://ai-sdlc.io/docs/tutorials) · [API Reference](https://ai-sdlc.io/docs/api-reference) · [Operations Runbooks](docs/operations/)

The framework is agent-agnostic — Claude Code, Codex, Cursor, Copilot, Aider, or any OpenAI-compatible API. See the [Agent Runner Reference](https://ai-sdlc.io/docs/api-reference/runners).

---

## For AI agents and human contributors discovering this repo

If you are an AI agent or a new contributor coming to this codebase for the first time, read these documents in order. Each is canonical for its concern:

1. **[`VISION.md`](VISION.md)** — the organizing thesis (Decision Engine, cost asymmetry, operator-as-decision-steward, anti-patterns ruled out). Every decision in this repo should trace back here.
2. **[`CLAUDE.md`](CLAUDE.md)** — operating conventions for any agent or contributor working in this repo: git flow (always rebase, never merge), branch + commit conventions, pre-push hooks, attestation requirements, backlog workflow, Pattern-C worktree isolation, plugin MCP routing. **Load this before doing any work.**
3. **[`CHARTER.md`](CHARTER.md)** — project governance, IP policy, CNCF alignment.
4. **[`spec/rfcs/README.md`](spec/rfcs/README.md)** — the architectural decisions registry. Every load-bearing design choice lives as an RFC. The registry table is the canonical lookup for numbers and lifecycle states; the Critical Path section traces dependencies.
5. **[`spec/spec.md`](spec/spec.md)** + **[`spec/`](spec/)** — the normative specification: resource model, policy enforcement, autonomy, agents, adapters, metrics.

Canonical execution paths (when working inside a Claude Code session):

| Use case | Command | Billing |
|---|---|---|
| Internal dogfood (backlog tasks) | `/ai-sdlc execute <task-id>` | Subscription |
| Manual cleanup | `/ai-sdlc cleanup [<task-id>]` | n/a |
| Shell-driven autonomous tick | `cli-orchestrator tick --spawner claude` | Subscription |
| GitHub issue / unattended / CI | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key |

Rules of thumb to internalize before pushing code:

- **Never merge PRs.** Only humans do. `gh pr merge` is off-limits.
- **Always rebase** feature branches onto main. Never merge main in.
- **Pattern C**: the parent working tree is read-only. All code work happens in `.worktrees/<task-id>/`. `/ai-sdlc execute` sets this up automatically.
- **Attestation is required** on `main`. Code PRs that touch source must carry a DSSE envelope signed by the reviewer chain. Docs-only PRs bypass.
- **Cross-repo writes** go through `permittedExternalPaths` in the task frontmatter.

The plugin's slash commands and MCP tools are documented in [`ai-sdlc-plugin/README.md`](ai-sdlc-plugin/README.md). The Step 0-13 pipeline is in [`pipeline-cli/README.md`](pipeline-cli/README.md).

---

## Packages

| Package | Path | Purpose |
|---|---|---|
| `@ai-sdlc/orchestrator` | [`orchestrator/`](orchestrator/) | Orchestrator runtime — CLI, runners, admission, state store |
| `@ai-sdlc/pipeline-cli` | [`pipeline-cli/`](pipeline-cli/) | Step 0-13 pipeline runtime; `cli-orchestrator`, `cli-deps`, `cli-decisions`, `cli-tui` |
| `ai-sdlc-plugin` | [`ai-sdlc-plugin/`](ai-sdlc-plugin/) | Claude Code plugin — hooks, slash commands, reviewer subagents, MCP server |
| `@ai-sdlc/sdk` | [`sdk-typescript/`](sdk-typescript/) | TypeScript SDK |
| `ai-sdlc-framework` | [`sdk-python/`](sdk-python/) | Python SDK (`pip install ai-sdlc-framework`) |
| `sdk-go` | [`sdk-go/`](sdk-go/) | Go SDK + Kubernetes-style operator CRDs |
| `@ai-sdlc/conformance` | [`conformance/`](conformance/) | Language-agnostic conformance test suite |
| `spec/` | [`spec/`](spec/) | Formal specification, RFCs, JSON schemas |

For development setup (`pnpm install`, build, test, schema validation), see [`docs/getting-started/`](docs/getting-started/) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Specification & versioning

The specification follows Kubernetes-style API maturity: **`v1alpha1`** today; `v1beta1` follows a 9-month deprecation window; `v1` follows a 12-month window. Resource types, policy enforcement levels, autonomy, agents, and adapters all live under [`spec/`](spec/) with JSON Schema (draft 2020-12) under [`spec/schemas/`](spec/schemas/).

Architectural changes go through the [RFC process](spec/rfcs/README.md). The registry there is the canonical lookup for every RFC number — active, reserved, withdrawn, and implemented.

---

## Contributing, governance, license

- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) — bug reports, feature requests, code, and spec changes (via [RFC](spec/rfcs/README.md))
- **Governance:** [`GOVERNANCE.md`](GOVERNANCE.md) — project roles, decision making, SIG structure
- **Charter:** [`CHARTER.md`](CHARTER.md) — mission, scope, IP policy, CNCF alignment
- **License:** [Apache 2.0](LICENSE) — commercial and open-source use, no restrictions
- **Code of Conduct:** [Contributor Covenant v2.1](CODE_OF_CONDUCT.md)

---

<div align="center">

**[Website](https://ai-sdlc.io)** · **[Documentation](https://ai-sdlc.io/docs)** · **[Specification](https://ai-sdlc.io/docs/spec/spec)** · **[Vision](VISION.md)** · **[Pricing](https://ai-sdlc.io/pricing)**

If you find this project useful, please consider giving it a star.

</div>
