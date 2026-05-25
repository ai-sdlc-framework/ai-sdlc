# Spec-Driven Development with AI-SDLC

AI-SDLC is a **Decision Engine** — its core value proposition is that the operator remains the decision-steward throughout the development lifecycle, while autonomous agents handle execution. Spec-driven development is the broader methodology that makes this sustainable: decisions are captured as artifacts before execution begins, so the engine has a clear contract to execute against.

This document explains how the two ideas compose, what authoring model the framework provides, and how to choose the right artifact altitude for any piece of work.

---

## Table of Contents

1. [What "spec-driven" means in this context](#1-what-spec-driven-means-in-this-context)
2. [Why the Decision Engine framing comes first](#2-why-the-decision-engine-framing-comes-first)
3. [The three-tier authoring model](#3-the-three-tier-authoring-model)
4. [The altitude rubric: choosing the right tier](#4-the-altitude-rubric-choosing-the-right-tier)
5. [When to skip tiers](#5-when-to-skip-tiers)
6. [The two-stage funnel: front-of-funnel tools + ai-sdlc](#6-the-two-stage-funnel-front-of-funnel-tools--ai-sdlc)
7. [The seam: DoR Gate as the quality boundary](#7-the-seam-dor-gate-as-the-quality-boundary)
8. [Cross-references and further reading](#8-cross-references-and-further-reading)

---

## 1. What "spec-driven" means in this context

> **"AI executes well-specified contracts deterministically."**
> — `VISION.md` §2

Spec-driven development means work doesn't start at the execution stage. It starts at a decision or design artifact that captures intent clearly enough for an autonomous agent to execute it without ambiguity. The quality of that upstream artifact is the single largest determinant of execution quality downstream.

This isn't a new idea — it's the same argument that distinguishes a well-specified ticket from a vague one, or a design doc from a hallway conversation. AI agents amplify both the benefit (deterministic execution on well-specified contracts) and the cost (wild divergence on ambiguous ones). The asymmetry of that amplification is why spec-driven tooling has emerged as a distinct category: tools like [GitHub Spec Kit](https://github.com/github/spec-kit) now cover the front-of-funnel arc (idea → contract) with the same depth that AI-SDLC covers the back-of-funnel arc (contract → shipped + governed code).

AI-SDLC is the **contract-to-shipped** half of a spec-driven stack.

---

## 2. Why the Decision Engine framing comes first

Spec-driven is a *category*. AI-SDLC's distinctive value within that category is the **operator-as-decision-steward substrate**:

- The [Decision Catalog (RFC-0035)](../../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) routes decisions to the right human actor — never to an autonomous agent acting unilaterally.
- The [DoR Gate (RFC-0011)](../../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) evaluates every task against a seven-point quality rubric before any execution dollar is spent.
- The attestation + quality-gate system produces a tamper-evident audit trail for every shipped artifact.
- Progressive autonomy (RFC-0010 §13) lets agents earn trust incrementally — decisions about promoting an agent's autonomy level remain with the operator.

Leading with "Decision Engine" communicates *how* AI-SDLC participates in spec-driven development: not just consuming specs, but preserving human decision authority throughout the lifecycle. Leading with "spec-driven" alone would position AI-SDLC as another artifact generator — which it isn't.

---

## 3. The three-tier authoring model

Adopter work comes in at different altitudes. Each altitude has a natural artifact type and a downstream consumer:

```
┌────────────────────────────────────────────────────────────┐
│  Tier 1: RFC (Decision)                                    │
│  "We're not sure how to approach this."                    │
│  Cross-cutting · architectural · controversial             │
│                                                            │
│  Artifact: Decision doc with problem, options,             │
│            recommendation, consequences                    │
│  Output: A position with rationale. Feeds spec authoring.  │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  Tier 2: Spec (Contract)                                   │
│  "We know the approach; we need an executable contract."   │
│  One feature · multiple tasks                              │
│                                                            │
│  Artifact: spec.md + plan.md + tasks.md + contracts/       │
│            (spec-kit, or equivalent authoring tool)        │
│  Output: A contract. Feeds the backlog.                    │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  Tier 3: Task (Deliverable)                                │
│  "We know what to ship."                                   │
│  One PR · single coherent deliverable                      │
│                                                            │
│  Artifact: Backlog task (.md file passing DoR Gate)        │
│  Output: A deliverable. Feeds the pipeline.                │
└────────────────────────────────────────────────────────────┘
```

### 3.1 What each tier produces

| Tier | Artifact | When to use | Output altitude |
|---|---|---|---|
| **RFC** | Decision doc | Cross-cutting; multi-feature; architectural; controversial; "we're not sure how to approach this" | A position (with rationale + consequences). Feeds spec authoring. |
| **Spec** | `spec.md` + `plan.md` + `tasks.md` + `contracts/` (spec-kit or equivalent) | "We know the approach; we need an executable contract." One feature, multiple tasks. | A contract. Feeds the backlog. |
| **Task** | Backlog task (`.md` file passing DoR) | "We know what to ship." One PR, single coherent deliverable. | A deliverable. Feeds the pipeline. |

### 3.2 Tier independence

The tiers compose sequentially — RFC feeds Spec feeds Task — but each is independently useful:

- A task can be authored directly without any upstream RFC or Spec. This is the correct default for most adopter day-to-day feature work.
- A Spec artifact (e.g. from spec-kit) can be imported to produce multiple tasks without an RFC above it.
- An RFC can exist at rest for weeks as a decision-in-flight without spawning a Spec or Task until the team is ready to move.

Nothing in the framework forces upward traversal. The pipeline's entry point is always the backlog task. What sits upstream of that is the adopter's choice.

---

## 4. The altitude rubric: choosing the right tier

Use the following questions to determine which tier a piece of work belongs at:

### Does this work involve a genuinely open question?

*An open question is one where reasonable engineers disagree about the right approach, or where the implications are cross-cutting enough that making the wrong choice would be expensive to reverse.*

- **Yes → RFC tier.** Document the problem, enumerate options, and align before execution.
- **No → skip to Spec or Task.**

### Does this work span multiple PRs or multiple features?

- **Yes → Spec tier.** A multi-task feature benefits from `plan.md` and `tasks.md` that name the subtasks explicitly. This is where spec-kit's `/speckit.plan` and `/speckit.tasks` commands add the most value.
- **No → Task tier.** A single PR's worth of bounded work can go directly to a backlog task.

### Does this work pass the DoR Gate on its own?

The [DoR Gate (RFC-0011)](../../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) checks seven rubric points before a task enters the pipeline. If you can express the work as a task with:

1. Binary-testable acceptance criteria
2. Named affected surface (file path, route, system)
3. Resolved named-thing references
4. Scope bounded to roughly one PR
5. Estimated complexity within the agent's autonomy tier
6. Dependencies identified
7. No open questions that block implementation

...then you're ready for Task tier immediately. The DoR Gate will tell you if you're not — its feedback loop is the Spec-tier signal in cases where a task doesn't survive the rubric.

---

## 5. When to skip tiers

### Most adopter work skips RFC

Day-to-day feature work goes Spec → Task or directly Task. Reserve the RFC altitude for genuinely cross-cutting decisions: "how should we model multi-tenancy?", "should we move to Postgres-as-vector-store?", "what's our caching strategy across services?". Bugfixes, single-PR features, refactors, and infrastructure tasks almost never need RFC altitude.

### Small adopter work skips Spec

A bugfix, a small refactor, or a single-PR feature that fits DoR's "scope is bounded" gate can go directly to Task tier. The Spec tier earns its weight when there are multiple tasks to coordinate and a `plan.md` prevents them from drifting apart. If a task doesn't survive DoR, the gate's feedback gives you the Spec-tier signal — it names which rubric point failed and what to clarify.

### Nothing skips Task

Every shipped PR has at least one backlog task that the DoR Gate validates. The task is the atomic unit of the pipeline. RFC and Spec artifacts are upstream inputs that produce tasks; they don't replace them.

---

## 6. The two-stage funnel: front-of-funnel tools + ai-sdlc

AI-SDLC is the back-of-funnel system. The front of the funnel — idea → contract — is handled by whatever tool the adopter team prefers:

```
┌──────────────────────────────┐        ┌─────────────────────────────────────────┐
│  Front of funnel             │  spec  │  AI-SDLC                                │
│                              │ ──────▶│                                         │
│  spec-kit (recommended)      │artifact│  DoR Gate → PPA → execute →             │
│  adopter RFC scaffold        │        │  cross-harness review → attest → merge  │
│  Linear / Notion / Confluence│        │                                         │
│  plain markdown              │        │  contract → shipped + governed           │
│                              │        │                                         │
│  idea → contract             │        │  Decision Engine throughout             │
└──────────────────────────────┘        └─────────────────────────────────────────┘
```

### 6.1 Spec-kit as the recommended front-end

[GitHub Spec Kit](https://github.com/github/spec-kit) covers the front-of-funnel arc with depth:
- `/speckit.constitution` — project principles and coding norms
- `/speckit.specify` — feature spec authoring from a problem statement
- `/speckit.clarify` — clarification loop
- `/speckit.plan` — architectural breakdown
- `/speckit.tasks` — per-task decomposition with acceptance criteria
- `/speckit.analyze` — cross-artifact consistency check

Spec-kit is **recommended, not required**. The framework's contract with adopters is the DoR Gate; whatever feeds it is the adopter's choice. Spec-kit is the recommended choice because its output format (`tasks.md` per feature) maps cleanly to backlog tasks, and its quality checks (`/speckit.analyze`) compose with the DoR Gate rather than duplicating it.

The Phase 4+ implementation of RFC-0036 will ship `ai-sdlc import-spec --from <path>` to automate the translation of spec-kit `tasks.md` output into backlog tasks with back-references.

### 6.2 The seam contract

For any upstream tool to feed AI-SDLC, its output must be translatable to backlog tasks where each task:

- Has a stable identifier
- Has acceptance criteria expressible as binary-testable checks (DoR gate 1)
- Names the affected surface (DoR gate 5)
- Resolves all named-thing references (DoR gate 3)
- Is bounded to roughly one PR's worth of work (DoR gate 4)

When upstream output meets this contract, the bridge is a translation step. When it doesn't, the DoR Gate surfaces the gaps so the adopter knows what to clarify upstream — the quality feedback loop that spec-driven tooling exists to create.

---

## 7. The seam: DoR Gate as the quality boundary

The [Definition of Ready Gate (RFC-0011)](../../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) is the single quality boundary between upstream authoring (whatever tool or process the adopter uses) and downstream execution (AI-SDLC's pipeline). This boundary is **not optional** and does not move based on what upstream tool produced the task.

The DoR Gate runs:
- At manual task authoring time (via `ai-sdlc refine <task-id>` or the MCP tool)
- At spec import time (when `ai-sdlc import-spec` ships in Phase 4+)
- As part of the autonomous orchestrator's admission chain (before any task is dispatched to a developer subagent)

The Decision Catalog ([RFC-0035](../../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)) routes DoR failures to the appropriate human actor — never silently discarding them or auto-resolving them. This is the "Decision Engine" pattern in action: the gate produces a decision event; the catalog routes it; the operator resolves it at the right altitude and cadence.

---

## 8. Cross-references and further reading

| Resource | What it covers |
|---|---|
| [RFC-0011: DoR Gate](../../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) | The seven-point quality rubric every task must pass before entering the pipeline |
| [RFC-0035: Decision Catalog](../../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) | How decisions are routed to the right human actor; the substrate for the Decision Engine framing |
| [RFC-0036: Spec-Kit Bridge](../../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) | The full adopter authoring RFC: three-tier model, spec-kit import path, adopter RFC scaffold, positioning updates |
| [Adopter Translators (BYO upstream)](adopter-translators.md) | Bring-your-own translator pattern for non-spec-kit upstreams (Linear, Notion, plain markdown); canonical `tasks.md` format; BYO → first-party promotion via RFC-0035 |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | The recommended front-of-funnel tool: idea → contract |
| [Getting Started](../getting-started/README.md) | Installation, CLI quick start, first pipeline |
| [spec/primer.md](../../spec/primer.md) | Conceptual introduction to the full framework |
| [VISION.md](../../VISION.md) | Framework vision and the cost-asymmetry argument |

---

*This document covers Phase 1 of RFC-0036 §13. Subsequent phases ship the spec-kit import CLI, adopter RFC scaffold, drift handling, and positioning updates to tutorials and getting-started surfaces.*
