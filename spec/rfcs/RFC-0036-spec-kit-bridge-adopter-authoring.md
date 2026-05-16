---
id: RFC-0036
title: Spec-Kit Bridge and Adopter Spec-Authoring Surface
status: Draft
lifecycle: Ready for Review
author: dominique@reliablegenius.io
created: 2026-05-13
updated: 2026-05-16
targetSpecVersion: v1alpha1
requires: [RFC-0010, RFC-0011, RFC-0024, RFC-0025, RFC-0035]
# Adopter-facing positioning + tooling RFC. Tutorial + getting-started surfaces
# land at sign-off; intentionally empty at Draft stage.
requiresDocs: []
---

# RFC-0036: Spec-Kit Bridge and Adopter Spec-Authoring Surface

**Status:** Ready for Review v0.2 — operator OQ walkthrough complete 2026-05-16; all 12 §14 OQs resolved. **Cross-cutting framing:** every operator-impacting resolution is **routed through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md)** — strict outcomes (tasks.md only, no fallback; drift requires explicit operator decision; full DoR rubric at import; strict schema versioning) are preserved while all "blocking + operator confirm" patterns are reshaped as Decisions with auto-resolution OR timeboxed default-on-silence. Pipeline never halts on RFC-0036 operations. §14.1 codifies the per-org config schema. Implementation broken into 11 phase tasks (AISDLC-326..336).
**Lifecycle:** Ready for Review
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-13
**Updated:** 2026-05-16
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io
- [ ] Product owner — Alexander Kline
- [ ] Operator owner — dominique@reliablegenius.io

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [The Three-Tier Adopter Authoring Model](#4-the-three-tier-adopter-authoring-model)
5. [The Two-Stage Funnel: spec-kit + ai-sdlc](#5-the-two-stage-funnel-spec-kit--ai-sdlc)
6. [Spec-Kit Bridge: Import Path](#6-spec-kit-bridge-import-path)
7. [Adopter RFC Scaffold](#7-adopter-rfc-scaffold)
8. [Positioning Updates](#8-positioning-updates)
9. [Schema Changes](#9-schema-changes)
10. [Composition with Other RFCs](#10-composition-with-other-rfcs)
11. [Backward Compatibility](#11-backward-compatibility)
12. [Alternatives Considered](#12-alternatives-considered)
13. [Implementation Plan](#13-implementation-plan)
14. [Open Questions](#14-open-questions)
15. [References](#15-references)

---

## 1. Summary

[GitHub Spec Kit](https://github.com/github/spec-kit) (v0.8.9, 98k+ stars, 30+ AI-tool integrations) has emerged as a mature spec-driven-development toolkit. Its workflow — `/speckit.constitution` → `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement` — covers **idea → executable contract**. Ai-sdlc covers the opposite end of the funnel: **contract → shipped + governed code** via the DoR Gate, PPA admission, autonomous orchestration, attestations, quality gates, progressive autonomy, and cross-harness review.

This RFC defines the seam between the two systems and operationalizes the positioning shift seeded by [AISDLC-248](../../backlog/completed/) (release readiness + repositioning beyond governance, 2026-05-11). Specifically:

1. A **three-tier adopter authoring model** — RFC (decision) → Spec (executable contract) → Task (single deliverable) — that names when each artifact altitude is correct
2. A **spec-kit import path** (`ai-sdlc import-spec`) that translates `.specify/specs/<feature>/tasks.md` into backlog tasks with back-references and runs them through DoR
3. An **optional adopter RFC scaffold** for the smaller class of strategic / cross-cutting work that doesn't fit the Task altitude and where adopters aren't using spec-kit
4. **Positioning updates** to `docs/concepts/` and `docs/getting-started/` that explicitly name ai-sdlc as the execution-and-governance half of a spec-driven development stack

Spec-kit is **recommended, not required**. Adopters can use spec-kit, can use the adopter RFC scaffold, can use a third-party tool (Linear / Notion / etc.), or can author backlog tasks directly. The framework's contract with adopters is the DoR Gate; whatever feeds into it is the adopter's choice.

## 2. Motivation

### 2.1 Spec-driven development is the right paradigm and we're already substantively there

`VISION.md` §2 names the framework's leverage move: "AI executes well-specified contracts deterministically." That IS spec-driven development. The DoR Gate ([RFC-0011](RFC-0011-definition-of-ready-gate.md)) enforces spec quality. The YAML resources adopters declare via `ai-sdlc init` are specs. The PPA scoring evaluates spec strategic fit. The reviewer agents verify the spec was implemented. The framework's product surface is already a spec-execution engine — it has just been positioned around governance, autonomy, and orchestration rather than the spec-driven framing.

The [AISDLC-248 family](../../backlog/completed/) (Done 2026-05-11) began the positioning shift: v0.10.0 release, README + website messaging refresh, new `content/docs/concepts/` including a spec primer. This RFC formalizes the next layer — adopter-facing tooling and clear authoring altitudes — and documents how ai-sdlc composes with the broader spec-driven ecosystem rather than competing with it.

### 2.2 The adopter authoring surface has a gap

Today an adopter encounters this path:

```
install plugin → ai-sdlc init → declare YAML resources → author backlog tasks → run /ai-sdlc execute
```

There is no prescribed (or even documented) artifact altitude above the backlog task. Adopters with strategic work ("should we move to Postgres-as-vector-store?", "how should we model multi-tenancy?") have nowhere to think out loud — the DoR Gate's seven-point rubric is calibrated for *deliverables*, not *decisions*, so the work either gets shoehorned into a task that won't survive DoR or skipped as artifact altogether. The cost-asymmetry argument (`VISION.md` §2) breaks down without an artifact altitude for the decision tier.

### 2.3 Spec-kit fills the front-of-funnel gap without competing with ai-sdlc

The clean architectural read after research (see §15 References):

| Stage | What it produces | Owner |
|---|---|---|
| **Idea → Decision** | RFC-style design artifact; rationale; alignment | adopter (template scaffold) |
| **Decision → Contract** | `spec.md`, `plan.md`, `tasks.md`, `contracts/` | spec-kit (or adopter's tool of choice) |
| **Contract → Shipped** | DoR-passed tasks, attested PRs, gated merges | ai-sdlc |

The three tiers compose sequentially. Spec-kit has 30+ integrations, an established CLI, and meaningful community traction. Building a competing front-end would duplicate work and split the spec-driven ecosystem. Wrapping spec-kit under our namespace would couple our release cadence and slash-command namespace to a community project. **Bridging** (consume spec-kit output as a recognized input format; document the seam; stay agnostic to alternatives) plays to both projects' strengths.

### 2.4 Forcing RFCs on adopters would be a mistake

RFCs in our internal practice (`spec/rfcs/`) are heavyweight by design — sign-off ceremony, lifecycle frontmatter, requiresDocs gating, registry numbering. That weight is correct for framework design but wrong for adopter feature work. The DoR Gate's G7 promise ("well-formed issues pass DoR in <5 seconds") would be violated if every adopter feature had to go through RFC ceremony first. The right move is **offer, don't prescribe**: an `ai-sdlc rfc init` scaffold exists for the smaller class of cross-cutting decisions, but the default authoring path remains the task.

## 3. Goals and Non-Goals

### 3.1 Goals

- **G1.** Document the three-tier authoring altitude model (RFC → Spec → Task) and the rubric for choosing between them.
- **G2.** Ship a spec-kit import path (`ai-sdlc import-spec`) that translates spec-kit artifacts into backlog tasks with back-references.
- **G3.** Ship an optional, lightweight adopter RFC scaffold (`ai-sdlc rfc init`) distinct from the internal RFC process.
- **G4.** Update adopter-facing positioning to explicitly name ai-sdlc as the contract-to-shipped half of spec-driven development.
- **G5.** Stay tool-agnostic. Spec-kit is the recommended front-end; alternatives (Linear, Notion, Confluence, plain markdown) are explicitly supported via a documented bridge contract.
- **G6.** Preserve the DoR Gate as the single quality boundary. Whatever feeds the gate is the adopter's choice; the gate's contract is unchanged.

### 3.2 Non-Goals

- **N1.** Build competing `/specify`, `/plan`, `/tasks` slash commands. Spec-kit already does this well; we don't duplicate.
- **N2.** Wrap spec-kit's CLI under the ai-sdlc namespace. Coupling release cadence and slash-command namespace to a community project is unnecessary risk; the bridge is enough.
- **N3.** Mandate spec-kit (or any specific upstream tool) for any class of adopter work.
- **N4.** Force adopter features through an RFC. The Task altitude is the default; the RFC altitude is offered for cross-cutting work only.
- **N5.** Replace the internal RFC process (`spec/rfcs/`). That stays as-is; the adopter scaffold is a separate, lighter artifact.
- **N6.** Lock the spec-kit integration tight. The bridge consumes `tasks.md` as an input format with a documented adapter; spec-kit's internal evolution does not bind ours.

## 4. The Three-Tier Adopter Authoring Model

Each tier produces an artifact at a different altitude. Adopters choose the highest tier they need; lower tiers compose downstream.

### 4.1 The rubric

| Tier | Artifact | When to use | Output altitude |
|---|---|---|---|
| **RFC** | Decision doc | "We're not sure how to approach this." Cross-cutting; multi-feature; architectural; controversial. | A position (with rationale + consequences). Feeds spec authoring. |
| **Spec** | `spec.md` + `plan.md` + `tasks.md` + `contracts/` (spec-kit, or equivalent) | "We know the approach; we need an executable contract." One feature, multiple tasks. | A contract. Feeds the backlog. |
| **Task** | Backlog task (`.md` file passing DoR) | "We know what to ship." One PR, single coherent deliverable. | A deliverable. Feeds the pipeline. |

### 4.2 When to skip tiers

- **Most adopter work skips RFC.** Day-to-day feature work goes Spec → Task or directly Task. Reserve RFC for genuinely cross-cutting decisions.
- **Small adopter work skips Spec.** A bugfix, a single-PR feature, or a refactor that fits DoR's "scope is bounded" gate can go directly Task. The Spec tier earns its weight on multi-task features.
- **Nothing skips Task.** Every shipped PR has at least one backlog task that the DoR Gate validates.

### 4.3 What this isn't

This is not a process gate — adopters are not asked to "justify" their tier choice. There is no enforcement that forces RFC-tier work to produce an RFC document. The framework simply documents the altitudes and offers scaffolds for each; adopter teams calibrate their own usage based on their decision velocity, team size, and historical regrets.

## 5. The Two-Stage Funnel: spec-kit + ai-sdlc

### 5.1 Sequential composition

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  spec-kit (or adopter      │  spec   │  ai-sdlc                     │
│  RFC scaffold / Linear /   │───────▶ │                              │
│  Notion / plain markdown)  │ artifact│  DoR → PPA → execute →       │
│                            │         │  review → attest → merge     │
│  idea → contract           │         │  contract → shipped          │
└────────────────────────────┘         └──────────────────────────────┘
```

The seam is the **spec artifact** (typically `tasks.md` or a backlog task file). Spec-kit emits it. Ai-sdlc consumes it. Each side can evolve independently as long as the seam contract holds.

### 5.2 What each system handles well

| Capability | spec-kit | ai-sdlc |
|---|---|---|
| Constitution / project principles | ✓ (`constitution.md`) | ✓ (`CLAUDE.md`, governance YAML) |
| Feature spec authoring | ✓ (`/speckit.specify`) | — (delegated to upstream) |
| Architectural plan | ✓ (`/speckit.plan`) | — (delegated to upstream) |
| Task breakdown | ✓ (`/speckit.tasks`) | partial (manual authoring) |
| Cross-artifact consistency check | ✓ (`/speckit.analyze`) | ✓ at task tier (DoR Gate) |
| Clarification loop | ✓ (`/speckit.clarify`) | ✓ at task tier (DoR Gate clarification round) |
| Implementation | partial (`/speckit.implement`) | ✓ (`/ai-sdlc execute` with subagents) |
| Quality gates / attestation / merge governance | — | ✓ (multi-tier; required) |
| Progressive autonomy | — | ✓ (RFC-0010 §13) |
| Cross-harness review | — | ✓ (RFC-0010 §13) |
| Cost governance | — | ✓ (RFC-0004) |
| Dependency-graph composition | — | ✓ (RFC-0014) |
| Autonomous orchestration | — | ✓ (RFC-0015) |

The asymmetry is informative — spec-kit is a **front-of-funnel artifact generator**; ai-sdlc is a **back-of-funnel execution + governance system**. Neither is a subset of the other, and the overlap (clarification, analysis) is at the seam where both can productively run.

### 5.3 The seam contract

For an upstream tool to feed ai-sdlc, its output MUST be translatable to one or more backlog tasks where each task:

- Has a stable identifier (the upstream tool's task id, or one assigned during import)
- Has acceptance criteria expressible as binary-testable checks (DoR gate 1)
- Names the affected surface (file path, route, system, RFC-0011 gate 5)
- Resolves all named-thing references (RFC-0011 gate 3)
- Is bounded to roughly one PR's worth of work (RFC-0011 gate 4)

When the upstream tool's output meets this contract, the bridge is a translation step. When it doesn't (e.g. a vague spec.md without per-task ACs), the bridge surfaces the DoR failures so the adopter knows what to clarify upstream — *exactly* the kind of feedback loop the spec-driven approach exists to create.

## 6. Spec-Kit Bridge: Import Path

### 6.1 CLI shape

```bash
ai-sdlc import-spec --from .specify/specs/auth-feature/ [options]

Options:
  --dry-run             Validate without writing tasks
  --tasks-only          Import only tasks.md (skip spec.md/plan.md context)
  --force               Re-import even if tasks already exist
  --rubric strict|warn  DoR severity for import-time validation (default: warn)
```

The command reads `tasks.md` (and optionally `spec.md` / `plan.md` for context), produces one backlog task per task entry, runs the DoR Gate on each generated task, and reports any failures.

### 6.2 Generated task shape

For each spec-kit task entry, the import creates a backlog task with `specRef:` frontmatter pointing back:

```yaml
---
id: AISDLC-512
title: 'Implement bearer-token validator'
status: To Do
specRef:
  source: spec-kit
  featureId: auth-feature
  taskId: T-007
  artifactPath: .specify/specs/auth-feature/tasks.md
  contractsPath: .specify/specs/auth-feature/contracts/auth-api.yaml
  importedAt: 2026-05-13T15:00:00Z
acceptanceCriteria:
  - 'POST /auth/validate returns 200 when token is well-formed and unexpired'
  - 'POST /auth/validate returns 401 when token is malformed'
  - 'POST /auth/validate returns 401 when token is expired'
---
<task body imports relevant sections from spec.md + tasks.md>
```

### 6.3 DoR at import time

The bridge runs the DoR Gate (RFC-0011) on each generated task **at import time**, before the task lands in `backlog/tasks/`. Failures are surfaced to the adopter with:

- Which DoR gate failed
- Which spec-kit artifact section produced the failing task
- A suggested upstream clarification (e.g. "T-007 acceptance criteria not binary-testable; consider tightening spec.md section §3.4")

This positions the bridge as a **quality gate at the seam**, not just a translator. Spec-kit's `/speckit.analyze` and ai-sdlc's DoR Gate run in series; together they enforce spec quality at two altitudes (cross-artifact consistency upstream; per-task readiness downstream).

### 6.4 Drift handling

When upstream spec-kit artifacts change after import, the bridge supports `ai-sdlc import-spec --reconcile`:

- Detects drift between `specRef.artifactPath` content and imported tasks
- For unchanged tasks: no-op
- For modified tasks: surfaces a diff and asks operator to confirm re-import (which preserves the task id but updates body + ACs)
- For removed upstream tasks: marks imported task as `superseded` (does not auto-delete)
- For new upstream tasks: creates new backlog tasks

Drift handling is **operator-initiated**, not automatic. Spec-kit churns at its own pace; backlog tasks may already be In Progress when upstream changes — silent overwriting would destroy in-flight work.

## 7. Adopter RFC Scaffold

### 7.1 CLI shape

```bash
ai-sdlc rfc init <slug> [--template <name>]

Examples:
  ai-sdlc rfc init multi-tenancy-model
  ai-sdlc rfc init postgres-vector-migration --template architecture
```

Scaffolds a new RFC at `<adopter-repo>/rfcs/RFC-<slug>.md` (or a configured path) from a template.

### 7.2 Template shape (illustrative)

```markdown
# RFC: <Title>

**Status:** Draft | In Review | Decided
**Author:** <name>
**Created:** <date>

## Problem

What decision are we trying to make? Why now?

## Options

### Option A — <name>
- Description
- Pros
- Cons
- Open questions

### Option B — <name>
...

## Recommendation

Which option, with rationale.

## Consequences

What changes downstream of this decision?

## Open Questions

1. ?
2. ?
```

Deliberately lighter than the internal `RFC-0001-template.md`: no frontmatter schema, no sign-off ceremony, no lifecycle / requiresDocs / registry numbering. The adopter team adapts the template as their process matures.

### 7.3 What this scaffold isn't

- **Not a gate.** Nothing forces strategic adopter work through this template.
- **Not stored in the framework.** The RFC lives in the adopter's repo, in their version control, under their conventions.
- **Not auto-validated.** No DoR-equivalent runs on adopter RFCs; the artifact is for human alignment, not pipeline admission.
- **Not coupled to the internal RFC process.** When the internal RFC template evolves (e.g. adds new sign-off fields), the adopter template stays stable.

### 7.4 Composition with the Decision Catalog (RFC-0035)

If [RFC-0035](RFC-0035-decision-catalog-operator-routing.md) lands, the adopter RFC's `Open Questions` section can optionally feed the operator's decision catalog via `ai-sdlc rfc index` (creates `Decision` records with `source: adopter-rfc`). This is opt-in; the scaffold is useful with or without RFC-0035.

## 8. Positioning Updates

Builds on the AISDLC-248 family (already shipped 2026-05-11). Net-new surfaces:

| Surface | Purpose |
|---|---|
| `docs/concepts/spec-driven.md` | Names ai-sdlc as the back-of-funnel half of spec-driven development; introduces the three-tier authoring model |
| `docs/tutorials/N-spec-kit-bridge.md` | Walkthrough: install spec-kit → author a feature spec → import to ai-sdlc → run pipeline |
| `docs/tutorials/N-adopter-rfc.md` | Walkthrough: when to write an RFC; using `ai-sdlc rfc init`; example of a multi-tenancy decision RFC |
| `docs/getting-started/README.md` (revision) | Adds the three-tier altitude model to the first-run narrative; spec-kit as a recommended companion |
| `README.md` (revision) | Repositions framework copy from "governance + orchestration" to "contract-to-shipped half of spec-driven development"; cross-links spec-kit |

Phasing the positioning copy across these surfaces avoids the previous "RFCs ship without docs" failure mode ([memory: project_doc_drift.md](../../docs/operations/)).

## 9. Schema Changes

### 9.1 Backlog task frontmatter

Add optional `specRef:` field to backlog task schema. Schema fragment (illustrative):

```json
{
  "properties": {
    "specRef": {
      "type": "object",
      "description": "Back-reference to the upstream spec artifact that produced this task.",
      "properties": {
        "source":        { "type": "string", "enum": ["spec-kit", "adopter-rfc", "linear", "notion", "inline", "other"] },
        "featureId":     { "type": "string" },
        "taskId":        { "type": "string" },
        "artifactPath":  { "type": "string" },
        "contractsPath": { "type": "string" },
        "importedAt":    { "type": "string", "format": "date-time" }
      },
      "required": ["source"]
    }
  }
}
```

Field is **optional** — existing backlog tasks (and direct-authored new tasks) work unchanged.

### 9.2 New CLI commands

- `ai-sdlc import-spec --from <path> [--reconcile]` — spec-kit import + drift handling
- `ai-sdlc rfc init <slug> [--template <name>]` — adopter RFC scaffold
- `ai-sdlc rfc index` — opt-in feeder for RFC-0035 Decision Catalog (if it lands)

### 9.3 New configuration

`<adopter-repo>/.ai-sdlc/config.yaml` gains optional fields:

```yaml
adopterRfc:
  enabled: true
  rfcDir: 'rfcs/'                       # where ai-sdlc rfc init writes
  template: 'architecture'              # default template
specKitBridge:
  enabled: true
  importDefaultRubric: 'warn'           # strict | warn
  importPath: '.specify/specs/'         # convention; override if elsewhere
```

All fields default-disabled — net-new behavior is opt-in per adopter.

## 10. Composition with Other RFCs

| RFC | Role | This RFC's relationship |
|---|---|---|
| [RFC-0010](RFC-0010-parallel-execution-worktree-pooling.md) §13 Adapter framework | Pattern for replaceable upstream tools | Spec-kit bridge ships as an adapter (adopter can swap for Linear/Notion equivalents) |
| [RFC-0011](RFC-0011-definition-of-ready-gate.md) DoR Gate | Single quality boundary at the seam | Unchanged contract; bridge runs DoR at import time |
| [RFC-0013](RFC-0013-product-first-implementation-strategy.md) Product strategy | Strategic positioning | This RFC operationalizes the spec-driven angle of the strategy |
| [RFC-0019](RFC-0019-embedding-provider-adapter.md) Embedding adapter | Adapter pattern precedent | Same architectural shape — upstream tool with documented bridge contract |
| [RFC-0029](RFC-0029-product-pillar-architectural-vision.md) Product pillar | Positioning framework | Provides the "ai-sdlc as half of spec-driven" framing |
| [RFC-0035](RFC-0035-decision-catalog-operator-routing.md) Decision Catalog | Optional downstream consumer | Adopter RFC's Open Questions can feed Decision records via `ai-sdlc rfc index` |

## 11. Backward Compatibility

- **No breaking changes.** All new surfaces are opt-in.
- Existing backlog tasks (without `specRef:`) work unchanged.
- Existing `/ai-sdlc execute` flow is unchanged.
- DoR Gate contract is unchanged.
- The internal RFC process (`spec/rfcs/`) is unchanged — the adopter scaffold is a separate artifact at a different altitude.

Adopters who don't use spec-kit and don't want the adopter RFC scaffold are unaffected — they continue to author backlog tasks directly.

## 12. Alternatives Considered

### 12.1 Alternative A — Compete (build our own `/specify` / `/plan` / `/tasks`)

Build slash commands and templates equivalent to spec-kit's, owned end-to-end. Rejected because:

- Spec-kit has 30+ integrations and 98k+ stars; we'd be duplicating mature work
- Splits the spec-driven ecosystem rather than composing with it
- Our front-of-funnel work would lag spec-kit's by design (spec-kit is their primary product; for us it would be a side surface)
- Adopters using spec-kit elsewhere couldn't bring their existing artifacts to ai-sdlc

### 12.2 Alternative B — Wrap (vendor spec-kit's slash commands under ai-sdlc namespace)

Re-export spec-kit's commands as `/ai-sdlc.specify`, `/ai-sdlc.plan`, etc. Rejected because:

- Couples our release cadence to spec-kit's
- Namespace collision risk if either project renames commands
- Inherits any spec-kit security or stability issues without ability to fix upstream
- Adopters already using spec-kit get two competing surfaces

### 12.3 Alternative C — Do nothing (status quo)

Keep adopter authoring at the Task altitude only; no positioning update; no spec-kit integration. Rejected because:

- The adopter authoring gap is real — strategic work has nowhere to land between idea and Task
- The spec-driven framing has industry traction; not adopting it is a positioning miss right when the AISDLC-248 family established the foothold
- Adopters using spec-kit independently have to manually translate to backlog tasks; we leave a free integration on the table

### 12.4 Alternative D — Mandate spec-kit

Make spec-kit the only supported front-of-funnel tool; require `.specify/` to exist before tasks can be created. Rejected because:

- Adopters using Linear / Notion / Confluence (or plain markdown) are first-class users today; mandating spec-kit breaks them
- Spec-kit is a community project; mandating a dependency on it puts ai-sdlc adopters at risk of upstream changes
- Violates `VISION.md` §6 ("You can leave anytime") — the bridge should be replaceable, not load-bearing

### 12.5 Alternative E — Adopt RFCs as a formal adopter process

Require an RFC for every adopter feature; gate task creation on RFC sign-off. Rejected because:

- Violates DoR Gate G7 ("well-formed issues pass DoR in <5 seconds") — most adopter work doesn't need RFC ceremony
- Our internal RFC process is heavyweight by design and inappropriate for adopter day-to-day work
- The Task altitude is the right default; the RFC scaffold is correctly offered (not prescribed)

## 13. Implementation Plan

Phased rollout behind feature flag `AI_SDLC_ADOPTER_AUTHORING=experimental` (mirrors RFC-0014 / RFC-0015 promotion convention):

- [ ] **Phase 1.** `docs/concepts/spec-driven.md` + three-tier authoring model + altitude rubric (docs-only; no code)
- [ ] **Phase 2.** `ai-sdlc rfc init` CLI + adopter RFC template + tutorial
- [ ] **Phase 3.** Backlog task schema: add optional `specRef:` field; update JSON Schema
- [ ] **Phase 4.** `ai-sdlc import-spec --from <path>` CLI for spec-kit `tasks.md` import (no reconcile yet)
- [ ] **Phase 5.** DoR Gate runs at import time; failure surfacing with upstream-clarification hints
- [ ] **Phase 6.** `ai-sdlc import-spec --reconcile` for drift handling
- [ ] **Phase 7.** `docs/tutorials/N-spec-kit-bridge.md` walkthrough; getting-started revision
- [ ] **Phase 8.** Position-update PR sweep: README, top-level positioning, `content/docs/concepts/` (ai-sdlc-io repo)
- [ ] **Phase 9.** Optional `ai-sdlc rfc index` integration with RFC-0035 Decision Catalog (depends on RFC-0035 Phase 1+)
- [ ] **Phase 10.** Adapter-pattern documentation for non-spec-kit upstreams (Linear, Notion, plain markdown templates)
- [ ] **Phase 11.** Hybrid promotion runbook to flip default-on (`docs/operations/adopter-authoring-promotion.md`)

## 14. Open Questions — resolved (operator walkthrough 2026-05-16)

> **Resolution status (2026-05-16):** All 12 OQs resolved via operator walkthrough. Lifecycle promoted Draft → Ready for Review. **Cross-cutting framing:** every operator-impacting resolution routes through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md) — strict outcomes preserved (rigor), but "blocking + operator confirm" patterns reshaped as Decisions with auto-resolution OR timeboxed default-on-silence. §14.1 codifies the per-org config schema. Implementation broken into 11 phase tasks: AISDLC-326 through AISDLC-336.

### OQ-1: Seam artifact granularity

Does the bridge import from `tasks.md` only, or also from `spec.md` (one-task-per-AC) when `tasks.md` is absent?

**Resolution (2026-05-16):** **`tasks.md` only — no fallback.** Catalog-routed: spec-kit project lacking `tasks.md` → `cli-import-spec` emits `Decision: incomplete-spec-detected` → Stage A classifies as "upstream-incomplete" → auto-action: emit clarification task back to spec-kit project (e.g., "run `/speckit.tasks` then re-import") + log Decision for operator's batch review. Pipeline keeps running on whatever else is dispatchable. Strict + non-blocking. **Selected over fallback** because incomplete-spec fallbacks cause incomplete implementations — the exact failure mode the framework's quality contract prevents.

### OQ-2: specRef drift semantics

When an imported task is In Progress and upstream `tasks.md` changes, how do we handle drift?

**Resolution (2026-05-16):** **Catalog-routed drift handling via RFC-0035 Stage A/B/C.** Drift detected → `Decision: spec-drift-detected` → Stage A classifies severity (typo / cosmetic / semantic / scope) → **low-severity auto-syncs** (catalog applies the change) → **high-severity auto-defers with 24h override window** (per RFC-0024 §15.1 default-on-silence pattern) → operator surfaces in next batch review. **In-progress task continues against its dispatched version** — never halts. Default-on-silence at 24h expiry = no-fork (continue against dispatched version); operator can override during the window. Composes with G0: rigor preserved (drift is explicit decision) + zero blocking (no real-time pipeline interrupt).

### OQ-3: DoR strictness at import

Default `--rubric warn` softens import-time failures into warnings. Should `strict` be the default?

**Resolution (2026-05-16):** **Strict default; `--rubric warn` opt-out flag.** Matches modern dev-tool convention (TypeScript strict, Cargo, Renovate). Failed-DoR-at-import → `Decision: import-blocked-on-dor` → auto-action: emit clarification task back upstream (spec-kit project gets actionable feedback) + log Decision for operator's batch review. Strict + non-blocking. **Selected over warn-default** because the DoR rubric is the framework's quality contract; loosening it by default contradicts the contract.

### OQ-4: Adopter RFC storage convention

Default `<adopter-repo>/rfcs/` — but multi-repo adopters may want a central RFC repo.

**Resolution (2026-05-16):** **`<adopter-repo>/rfcs/` default; per-org override via `.ai-sdlc/adopter-authoring.yaml`.** Per-org-configurable convention matches the pattern adopted across RFC-0024 / 0025 / 0031 / 0035 / 0022. Default works for single-repo adopters (most common); multi-repo adopters override to point at the central RFC repo. No runtime Decision needed; pure config.

### OQ-5: RFC template variants

Ship one template, or three (architecture, product-decision, retrospective)?

**Resolution (2026-05-16):** **One template.** Cognitive load < flexibility for v1. Demand for variants becomes a future Decision in the catalog (operator weighs adopter demand signal); if signal is strong, future RFC splits the template.

### OQ-6: Cross-tool bridges

Does each non-spec-kit upstream (Linear, Notion, plain markdown) need a first-party adapter?

**Resolution (2026-05-16):** **Single documented "bring your own translator" pattern + spec-kit first-party adapter only.** Adapter-pattern convention (RFC-0003). v1 avoids N adapters; adopters with non-spec-kit upstreams write their own translator that emits the canonical task-import format. New first-party adapter requests become Decisions in the catalog (auto-defer; operator weighs adopter demand). Composes with G0: adapter-demand signal accumulates in catalog without blocking framework releases.

### OQ-7: Spec-kit `/speckit.analyze` overlap with DoR

When spec-kit's analyze pass already ran upstream, should DoR at import be a no-op?

**Resolution (2026-05-16):** **Full DoR runs; catalog auto-resolves analyze-covered Decisions via analyze metadata.** DoR generates Decisions per gate; analyze metadata (when available at `.specify/analyze.json`) auto-resolves matching gates via the catalog; only NEW gaps reach the operator. Falls back to full rubric when analyze metadata unavailable. **Selected over no-op trust-transitivity** because DoR is the framework's quality contract — no skip; selected over "always full rubric, accept duplicate cost" because the catalog mediates the trust + verify cleanly. Composes with G0: no duplicate operator prompts (catalog absorbs the overlap).

### OQ-8: Constitution composition

Spec-kit's `constitution.md` ≈ ai-sdlc's `CLAUDE.md` + governance YAML. Merge, separate, or ignore?

**Resolution (2026-05-16):** **Separate + drift detection via Decision Catalog.** Each tool owns its file (preserves both ecosystems' ownership). Bridge detects drift on shared-norm sections (start simple: rebase-vs-merge policy, branch-naming convention, review cadence) → emits `Decision: constitution-claudemd-drift` → catalog routes per Stage A/B/C → operator-batch review. Default-on-silence = drift accepted as intentional. **Selected over CLAUDE.md-canonical-auto-derive** because forcing framework norms onto spec-kit's constitution surface violates "spec-kit is recommended, not required" (§1). Composes with G0: drift surfaces but never blocks.

### OQ-9: Positioning leadership

"Spec-driven development" or "Decision Engine" as primary framing?

**Resolution (2026-05-16):** **Lead with "Decision Engine"; secondary "for spec-driven AI workflows" context.** Emphasizes the framework's unique value (operator-as-decision-steward + Decision Catalog substrate). Spec-driven is the broader category we participate in; Decision Engine is HOW we do it distinctively. **Selected over leading with spec-driven** because the framework's distinctive value is the substrate, not the category. Per `project_team_roles.md`, Product Authority (Alex) sign-off on this positioning is the path forward.

### OQ-10: What happens when DoR rejects an imported task

Create with `dorBlocked: true`, refuse import entirely, or create placeholder + emit clarification back to spec-kit?

**Resolution (2026-05-16):** **(c) Refuse import; emit clarification task back to spec-kit; log Decision for operator's batch review.** Composes directly with OQ-3 (strict default) + G0 (non-blocking). Refuse → fix upstream → re-import = correct loop. `dorBlocked: true` placeholder rejected because placeholders contaminate the backlog with non-dispatchable noise. Catalog absorbs the rejection event so adopter feedback is visible + actionable without blocking the pipeline.

### OQ-11: Versioning the seam contract

Pin supported spec-kit version range, or auto-detect schema and refuse unknowns?

**Resolution (2026-05-16):** **Auto-detect schema; refuse unknown formats via Decision routing.** Unknown spec-kit version → `Decision: upstream-schema-unknown` → auto-action: emit "upgrade ai-sdlc to support spec-kit v<N>" task + add to operator's batch review. Strict default (refuse unknown) + non-blocking (catalog absorbs the rejection). **Selected over pinned-version-range** because pinned ranges require explicit version bumps in the framework's release cycle; auto-detect + Decision-routing handles the long tail of spec-kit version drift without forcing framework releases for every spec-kit minor version.

### OQ-12: CLI vs slash-command surface

`ai-sdlc import-spec` shown as CLI; should it also exist as `/ai-sdlc import-spec` inside Claude Code?

**Resolution (2026-05-16):** **Both.** Existing dual-surface convention (`/ai-sdlc *` slash + `cli-*` bin). Established pattern across `/ai-sdlc execute`, `/ai-sdlc rebase`, etc.; no judgment needed for a new command following the same pattern.

### 14.1 Configuration Schema (per-org defaults)

Per-organization configurability is mandatory across the resolved OQs. The consolidated `.ai-sdlc/adopter-authoring.yaml` schema:

```yaml
adopter-authoring:
  rfc-scaffold:                       # OQ-4 — per-org RFC location override
    rfcDir: rfcs/                     # default; multi-repo override example: "../company-rfcs/"

  rfc-templates:                      # OQ-5 — one template in v1; variants future Decision
    defaultTemplate: framework-rfc.md

  import:                             # OQ-1 + OQ-3 + OQ-10 strict-by-default config
    artifactGranularity: tasks-md-only       # OQ-1: no fallback
    dorStrictness: strict                     # OQ-3: warn opt-out via --rubric flag
    dorRejection: refuse-emit-clarification   # OQ-10: refuse + emit upstream task

  drift-handling:                     # OQ-2 — drift Decision policy
    severityThresholds:
      typoCosmetic: auto-sync         # low severity: catalog auto-applies
      semanticScope: defer-24h-window # high severity: Decision with 24h override

  speckit-bridge:                     # OQ-7 + OQ-11 schema versioning
    analyzeMetadataPath: ".specify/analyze.json"   # null = skip analyze-aware DoR auto-resolve
    schemaDetection: auto             # auto-detect; refuse unknown
    refuseOnUnknown: true             # OQ-11 strict default

  cross-tool:                         # OQ-6 — single BYO translator pattern
    firstPartyAdapters: [speckit]
    byoTranslatorPath: ".ai-sdlc/translators/<adopter>.ts"

  constitution-drift:                 # OQ-8 — separate + drift detection
    detectionMode: shared-norm-sections
    rules:
      - rebase-vs-merge
      - branch-naming-convention
      - review-cadence
    driftAction: decision-batch       # surface via Decision Catalog, never block

  positioning:                        # OQ-9 (informational; not runtime-configurable)
    primary: decision-engine
    secondary: spec-driven-ai-workflows
```

Default constants ship in the `ai-sdlc init` adopter-authoring template. Auto-tuning + cross-tool first-party adapters are future Decisions in the catalog; operator-configurable from day one.

## 15. References

- [GitHub Spec Kit](https://github.com/github/spec-kit) — Front-of-funnel spec-driven development toolkit; the bridge target
- [`VISION.md`](../../VISION.md) §1–§3 — "AI executes well-specified contracts deterministically" framing
- [RFC-0010 §13](RFC-0010-parallel-execution-worktree-pooling.md) — Adapter framework pattern reused for the spec-kit bridge
- [RFC-0011](RFC-0011-definition-of-ready-gate.md) — DoR Gate; single quality boundary at the seam
- [RFC-0013](RFC-0013-product-first-implementation-strategy.md) — Product strategy; this RFC operationalizes the spec-driven positioning angle
- [RFC-0019](RFC-0019-embedding-provider-adapter.md) — Adapter pattern precedent (embedding providers); same architectural shape
- [RFC-0029](RFC-0029-product-pillar-architectural-vision.md) — Product pillar architectural vision; positioning framework
- [RFC-0035](RFC-0035-decision-catalog-operator-routing.md) — Decision Catalog; optional downstream consumer for adopter RFC Open Questions
- [AISDLC-248 family](../../backlog/completed/) — Release readiness + repositioning (shipped 2026-05-11)
- [`docs/getting-started/README.md`](../../docs/getting-started/README.md) — Current adopter first-run surface; revised in Phase 7
- [`docs/concepts/`](../../docs/concepts/) — Where the spec-driven concept doc lands (Phase 1)
