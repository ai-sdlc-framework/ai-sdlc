# AI-SDLC RFC Process

This document describes the RFC (Request for Comments) process for proposing changes to the AI-SDLC Framework specification. The process is modeled on Kubernetes KEPs (Kubernetes Enhancement Proposals) and OpenTelemetry OTEPs.

## What Requires an RFC

An RFC is required for:

- Adding, removing, or modifying a core resource type
- Adding or removing required fields from any resource schema
- Changing the semantics of existing normative requirements
- Adding a new interface contract to the adapter layer
- Adding or modifying enforcement levels
- Changing the autonomy level framework
- Adding a new conformance level
- Any change that could break backward compatibility

An RFC is **not** required for:

- Editorial fixes (typos, formatting, clarifications that do not change meaning)
- Adding optional fields to existing resource schemas
- Adding new enum values to existing fields
- Adding informative content to non-normative documents
- Updating examples or glossary entries

## RFC Lifecycle (AISDLC-118)

The `lifecycle` frontmatter field captures the per-owner sign-off + implementation arc:

```
Draft → Ready for Review → Signed Off → Implemented
                                              │
                                              └─→ Superseded (terminal)
```

| Lifecycle | Meaning | Sign-off state |
|---|---|---|
| **Draft** | Initial brainstorm; structure may shift | Sign-off boxes empty |
| **Ready for Review** | Structure stable; ready for owner sign-off | At least one owner signed; awaiting others |
| **Signed Off** | All owners signed; design locked | All owner boxes checked |
| **Implemented** | Corresponding milestone reached Done | n/a (post-sign-off state) |
| **Superseded** | Replaced by newer RFC | Header notes the successor |

**Drafts MUST land on main early.** As soon as the author considers the RFC shareable (typically after the first internal pass), it should be merged to main with `lifecycle: Draft`. Stakeholders can then reference it at its canonical `spec/rfcs/RFC-NNNN-*.md` URL while iteration continues through normal PR review. **Sign-off no longer gates visibility** — these are orthogonal questions. Hiding drafts until sign-off destroys the feedback loop the RFC process is supposed to create.

The `lifecycle` field is separate from the per-owner sign-off checklist that lives in the RFC body (`## Sign-Off`). The checklist is the source of truth for which individual owners have signed; `lifecycle` is the aggregate state used by the index table and tooling.

### Legacy `status` field

The original `status` enum (Draft / Under Review / Approved / Implemented / Final / Rejected / Withdrawn) is retained for back-compat with `scripts/check-rfc-docs.mjs`, which uses it to decide when to enforce the `requiresDocs` gate. New RFCs SHOULD set both fields. Mapping guide:

| `lifecycle` | Recommended `status` |
|---|---|
| `Draft` | `Draft` |
| `Ready for Review` | `Draft` (use legacy `Under Review` only if you want the WG-review semantics) |
| `Signed Off` | `Approved` (or `Final` for sign-off-gated RFCs whose reference impl is still in flight) |
| `Implemented` | `Implemented` (or `Final` retained from the pre-AISDLC-118 convention) |
| `Superseded` | `Withdrawn` (and link the successor in the body) |

## Legacy RFC Lifecycle (pre-AISDLC-118)

The flow below describes the original Kubernetes-KEP-style process. AISDLC-118 reframes the visibility question (drafts on main early) but the per-stage activity descriptions still apply.

```
Draft → Discussion → WG Review → PoC → Approval → Spec Update
```

### 1. Draft

The author creates a new RFC by copying `RFC-0001-template.md` to `RFC-NNNN-title.md` (where NNNN is the next available number) and fills in all sections. The author submits the RFC as a pull request.

**Status:** `Draft`

### 2. Discussion

Community members review and discuss the RFC via PR comments. The author addresses feedback and updates the RFC. Discussion should run for at least 7 days.

**Status:** `Under Review`

### 3. Working Group Review

The relevant SIG (Special Interest Group) reviews the RFC for design soundness:

- **sig-spec** — Changes to core resource types, resource model, or reconciliation semantics
- **sig-adapters** — Changes to adapter interfaces, registration, or discovery
- **sig-security** — Changes to autonomy levels, policy enforcement, or security model

The SIG provides a recommendation (approve, request changes, or reject).

**Status:** `Under Review`

### 4. Proof of Concept

For substantive changes, the author demonstrates feasibility with a proof-of-concept implementation. The PoC may be a PR to the reference implementation repository showing the proposed change works as described.

**Status:** `Under Review`

### 5. Approval

The RFC requires:

- Two maintainer approvals
- A 7-day final comment period after the last substantive change
- SIG recommendation of approval

**Status:** `Approved`

### 6. Spec Update

After approval, the spec is updated to incorporate the RFC. The RFC status is updated to reflect the outcome.

**Status:** `Implemented`

## RFC Status Values

| Status         | Description                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Draft`        | RFC is being written by the author                                                                                                                                            |
| `Under Review` | RFC is open for community discussion and SIG review                                                                                                                           |
| `Approved`     | RFC has been approved; spec update pending                                                                                                                                    |
| `Implemented`  | RFC has been merged into the specification                                                                                                                                    |
| `Final`        | Terminal pre-implementation status for sign-off-gated RFCs (RFC-0006, RFC-0008): the spec is locked but reference implementation work continues. Promotes to `Implemented` when the normative spec documents land. |
| `Rejected`     | RFC was reviewed and rejected                                                                                                                                                 |
| `Withdrawn`    | RFC was withdrawn by the author                                                                                                                                               |

## YAML Frontmatter Convention

Every RFC under `spec/rfcs/` MUST begin with a YAML frontmatter block (delimited by `---` on its own line, like Jekyll/Hugo posts). The frontmatter is the source of truth for tooling — CI workflows, dashboards, and the index table below all read it. The visible bold-status block in the RFC body (`**Status:** Draft`, etc.) is preserved for human readability but is informational only.

The schema lives at [`spec/schemas/rfc.schema.json`](../schemas/rfc.schema.json) and is the authoritative definition of allowed field names and values.

### Required fields

| Field          | Type            | Notes                                                                                                                                          |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | string          | Canonical identifier matching the filename prefix (`RFC-NNNN`).                                                                                |
| `title`        | string          | Human-readable title (no `RFC-NNNN:` prefix — that's encoded in `id`).                                                                          |
| `status`       | enum            | One of the RFC Status Values above.                                                                                                            |
| `author`       | string          | Primary author name(s). Comma-separated for multi-author RFCs.                                                                                  |
| `created`      | ISO 8601 date   | When the RFC was first authored.                                                                                                                |
| `updated`      | ISO 8601 date   | Most recent substantive update.                                                                                                                 |
| `requiresDocs` | array of enum   | Closed enum declaring which user-facing doc surfaces must reference this RFC. See "requiresDocs values" below. `[]` is valid for purely strategic RFCs. |

### Optional fields

| Field                  | Type           | Notes                                                                                                                                                  |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `targetSpecVersion`    | string         | Spec API version targeted (e.g. `v1alpha1`). Recommended.                                                                                              |
| `requires`             | array of RFC ID | RFCs this RFC depends on (e.g. RFC-0006 requires RFC-0002 and RFC-0004).                                                                              |
| `amends`               | array of RFC ID | RFCs this RFC amends (e.g. RFC-0010 amends RFC-0002).                                                                                                  |
| `deferredDocs`         | boolean        | Escape hatch — see below.                                                                                                                              |
| `deferredDocsDeadline` | ISO 8601 date   | Required when `deferredDocs: true`.                                                                                                                    |

### `requiresDocs` values

The closed enum is captured in the JSON schema. Each value maps to a `docs/` subdirectory:

| Value              | Maps to              | Use when…                                                                                                |
| ------------------ | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `tutorial`         | `docs/tutorials/`    | A walkthrough is needed to teach the new capability.                                                     |
| `operator-runbook` | `docs/operations/`   | Operators (anyone running the orchestrator in production) need a how-to-operate guide.                  |
| `api-reference`    | `docs/api-reference/` | The RFC introduces or changes a programmatic surface (TypeScript types, schemas, runtime APIs).         |
| `getting-started`  | `docs/getting-started/` | The RFC affects the first-run path / onboarding.                                                      |
| `example`          | `docs/examples/`     | A worked example file (config, code, transcript) is needed to show real usage.                          |

For each value listed in an RFC's `requiresDocs`, **at least one file** in the corresponding subdirectory MUST reference the RFC by its `id` (literal text, e.g. `RFC-0006`). The CI script in AISDLC-69.3 enforces this; AISDLC-69.2 (this PR) defines the convention.

### Deferred docs escape hatch

Some RFCs are sign-off-finalised before the matching docs can reasonably be authored — for example, when the spec is locked but the reference implementation is still in flight. For those:

```yaml
requiresDocs:
  - tutorial
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: 2026-06-30
```

CI passes but logs a warning that grows louder as the deadline approaches. Hard enforcement of the deadline is intentionally deferred to a future task — for now this is a forcing function, not a gate.

### Operator process — when authoring an RFC

1. Copy `RFC-0001-template.md` and fill in the YAML frontmatter at the top.
2. Pick the `status` value that matches your phase (`Draft` for new work) AND set the `lifecycle` field (also `Draft` for new work — see the [RFC Lifecycle (AISDLC-118)](#rfc-lifecycle-aisdlc-118) section above).
3. Decide which doc surfaces the RFC needs by walking through the `requiresDocs` enum. Pick the smallest set that covers the user-visible impact — empty (`[]`) is acceptable and correct for purely strategic / conceptual RFCs (e.g. RFC-0013 product strategy).
4. **Land the draft on main early.** As soon as the structure is shareable (typically after the first internal pass), open a PR that merges the RFC to main with `lifecycle: Draft`. Stakeholders can then reference it at the canonical `spec/rfcs/RFC-NNNN-*.md` URL while you iterate. Sign-off no longer gates visibility.
5. As the design matures, flip `lifecycle` through the states (Draft → Ready for Review → Signed Off → Implemented) via subsequent PRs that update the frontmatter alongside the per-owner sign-off checklist in the body.
6. **Before requesting `Approved` status**, ensure each surface in `requiresDocs` has at least one doc file referencing the RFC by its `id`. If the docs aren't ready, set `deferredDocs: true` with a deadline AND file a backlog task for the gap (so the orchestrator can eventually pick it up).
7. When the spec lands and the docs exist, flip `status` to `Implemented` (or `Final` for sign-off-gated RFCs), set `lifecycle: Implemented`, and remove `deferredDocs` if it was set.

## File Naming

RFC files follow the pattern:

```
RFC-NNNN-short-title.md
```

- `NNNN` is a zero-padded sequential number
- `short-title` is a lowercase, hyphenated summary (e.g., `custom-resource-types`)

## Claiming an RFC number (AISDLC-165)

Numbers are allocated **sequentially**. The single source of truth is the [Registry](#registry) table below — if your number isn't in the registry, you do not own it. To claim a number, you must EITHER:

1. **Open a PR** that adds your RFC file at `spec/rfcs/RFC-NNNN-<slug>.md` AND adds the registry row pointing to your filename, OR
2. **Reserve** by opening a PR that just adds a registry row marked `Status: Reserved` / `Lifecycle: Placeholder` with a one-line description in the Notes column of what you intend to write. Reserved entries hold the number while the design matures; promote to a real entry by amending the row when the file lands.

To pick the next available number: scan the registry, take the highest number, add 1. If two PRs claim the same number simultaneously, the one that lands first wins; the loser must rename. Reserved numbers may be released back to the pool by removing the row (or marking `Status: Released` and garbage-collecting later).

The registry covers four states:

- **Active** — the RFC file exists and is in some lifecycle phase (Draft / Ready for Review / Signed Off / Implemented).
- **Reserved** — number is held; no file yet. Notes column explains the intended scope.
- **Withdrawn** — number was claimed but the work was folded into another RFC or abandoned. The number is NOT recycled (slot collisions are confusing — see RFC-0003 / RFC-0013 history).
- **Template** — RFC-0001 only.

## Registry

| #     | Title                                                                                                | Status      | Lifecycle    | Author                                                          | File                                                                              | Notes                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------- | ------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0001  | Template                                                                                             | n/a         | Template     | —                                                               | [RFC-0001-template.md](RFC-0001-template.md)                                      | Skeleton for new RFCs; not normative.                                                                       |
| 0002  | Pipeline Orchestration Policy                                                                        | Draft       | Draft        | AI-SDLC Contributors                                            | [RFC-0002-pipeline-orchestration.md](RFC-0002-pipeline-orchestration.md)          | requiresDocs: tutorial, api-reference, example                                                              |
| 0003  | Infrastructure Provider Adapters                                                                     | Draft       | Draft        | AI-SDLC Contributors                                            | [RFC-0003-infrastructure-adapters.md](RFC-0003-infrastructure-adapters.md)        | Slot collision resolved in AISDLC-109 (product-strategy renumbered to RFC-0013).                            |
| 0004  | Cost Governance and Attribution                                                                      | Draft       | Draft        | AI-SDLC Contributors                                            | [RFC-0004-cost-governance-and-attribution.md](RFC-0004-cost-governance-and-attribution.md) | requiresDocs: tutorial, api-reference, operator-runbook                                                     |
| 0005  | Product Priority Algorithm (PPA)                                                                     | Draft       | Draft        | Alexander Kline (Arcana Concept Studio), AI-SDLC Contributors    | [RFC-0005-product-priority-algorithm.md](RFC-0005-product-priority-algorithm.md)  | requiresDocs: api-reference, operator-runbook                                                               |
| 0006  | Design System Governance Pipeline                                                                    | Final       | Implemented  | Dominique Legault, Morgan Hirtle, Alexander Kline                | [RFC-0006-design-system-governance-v5-final.md](RFC-0006-design-system-governance-v5-final.md) | requiresDocs: tutorial, operator-runbook, api-reference                                                     |
| 0007  | Figma Make Pipeline Integration                                                                      | Final       | Signed Off   | Dominique Legault, Morgan Hirtle, Alexander Kline                | [RFC-0007-figma-make-pipeline-integration-v1-final.md](RFC-0007-figma-make-pipeline-integration-v1-final.md) | requires RFC-0002, RFC-0004, RFC-0006.                                                                      |
| 0008  | PPA Triad Integration                                                                                | Final       | Implemented  | Dominique Legault, Morgan Hirtle, Alexander Kline                | [RFC-0008-ppa-triad-integration-final-combined.md](RFC-0008-ppa-triad-integration-final-combined.md) | requiresDocs: api-reference, operator-runbook                                                               |
| 0009  | Tessellated Design Intent Documents                                                                  | Draft       | Draft        | Alexander Kline                                                  | (in-flight — see branch `rfc/0009-tessellated-design-intent-documents`)           | v3.4 (2026-05-04) resolves all 13 OQs; OQ-3 + OQ-7 carve out follow-on patterns reserved as RFC-0017, RFC-0018, RFC-0020, RFC-0021. |
| 0010  | Parallel Execution and Worktree Pooling                                                              | Draft       | Implemented  | Dominique Legault                                                | [RFC-0010-parallel-execution-worktree-pooling.md](RFC-0010-parallel-execution-worktree-pooling.md) | Legacy `status: Draft` retained; AISDLC-70.1–70.9 all Done. amends RFC-0002 + RFC-0004.                     |
| 0011  | Definition-of-Ready Gate for Pipeline Admission                                                      | Draft       | Signed Off   | dominique@reliablegenius.io                                      | [RFC-0011-definition-of-ready-gate.md](RFC-0011-definition-of-ready-gate.md)      | requiresDocs: [] (phased rollout — docs land per phase).                                                    |
| 0012  | Two-Tier Pipeline Architecture with Shared Core Library                                              | Approved    | Signed Off   | dominique@reliablegenius.io                                      | [RFC-0012-two-tier-pipeline-architecture.md](RFC-0012-two-tier-pipeline-architecture.md) | Internal architecture; no user-facing docs required.                                                        |
| 0013  | AI-SDLC Orchestrator — Product Strategy                                                              | Draft       | Draft        | AI-SDLC Contributors                                            | [RFC-0013-product-first-implementation-strategy.md](RFC-0013-product-first-implementation-strategy.md) | Strategic / conceptual. Renumbered from former RFC-0003 collision (AISDLC-109).                             |
| 0014  | Dependency Graph Composition for Pipeline Decisions                                                  | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0014-dependency-graph-composition.md](RFC-0014-dependency-graph-composition.md) | Phased rollout; no docs surfaces yet.                                                                       |
| 0015  | Autonomous Pipeline Orchestrator                                                                     | Draft       | Ready for Review | dominique@reliablegenius.io                                  | [RFC-0015-autonomous-pipeline-orchestrator.md](RFC-0015-autonomous-pipeline-orchestrator.md) | requires RFC-0010, RFC-0011, RFC-0012, RFC-0014.                                                            |
| 0016  | Estimation Calibration with T-Shirt Sizes                                                            | Draft       | Ready for Review | dominique@reliablegenius.io                                  | [RFC-0016-estimation-calibration-tshirt-sizes.md](RFC-0016-estimation-calibration-tshirt-sizes.md) | requires RFC-0011, RFC-0015.                                                                                |
| 0017  | In-Soul Variant Pattern                                                              | Draft       | Draft        | Morgan Hirtle                                                   | [RFC-0017-in-soul-variant-pattern.md](RFC-0017-in-soul-variant-pattern.md)        | Carved out of RFC-0009 per OQ-3. Variant = a soul-scoped sub-theme with distinct visual identity and audience specialization. Practitioner validation via SpryPoint product suite (SpryEngage / SpryMobile / SpryCIS / SpryBackflow as four souls on shared substrate). requires RFC-0009. |
| 0018  | In-Soul Journey Pattern                                                              | Draft       | Draft        | Morgan Hirtle                                                   | [RFC-0018-in-soul-journey-pattern.md](RFC-0018-in-soul-journey-pattern.md)        | Carved out of RFC-0009 per OQ-3. Journey = a temporally-ordered user flow within a soul that carries distinct design intent and completion criteria. Practitioner validation via SpryPoint accessibility audit pipeline. requires RFC-0009, RFC-0017. |
| 0019  | Embedding Provider Adapter Framework                                                                 | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0019-embedding-provider-adapter.md](RFC-0019-embedding-provider-adapter.md)  | Adapter framework for text→vector embedding providers; OpenAI text-embedding-3-small ships as default; adopters can plug custom adapters per the harness-adapter pattern (RFC-0010 §13). |
| 0020  | Session-bug + Severity Scoring Rule                                                                  | Draft       | Draft        | —                                                               | (none yet — reservation only; draft ships in follow-on PR)                        | Carved out of RFC-0009 §13.5 per OQ-7 reversal of Position-stated; Dπ₃ refinement with practitioner validation.                          |
| 0021  | Incident Monitoring + Root-Cause Analysis                                                            | Reserved    | Placeholder  | —                                                               | (none yet)                                                                        | Carved out of RFC-0009 §13.6 per OQ-7 reversal of Position-stated; pending adopter incident data before normative spec.                  |
| 0022  | Compliance Posture + Audit Surface                                                                   | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0022-compliance-posture-audit-surface.md](RFC-0022-compliance-posture-audit-surface.md) | Adopter declares regulatory posture (HIPAA/SOC2/PCI-DSS/GDPR/etc.); framework derives gate defaults (DB pool isolation, secret-scan strictness, attestation requirement, retention) and exports audit evidence packs. RFC-0020 and RFC-0021 carved out of RFC-0009 (OQ-7); RFC-0009 OQ-11 trigger checklist references RFC-0022 as the canonical regime-declaration surface. |
| 0023  | Operator TUI — Pipeline Monitoring + Steering Surface                                                | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0023-operator-tui-pipeline-monitoring.md](RFC-0023-operator-tui-pipeline-monitoring.md) | Operator-facing terminal interface to monitor + unblock the autonomous pipeline (post-RFC-0015). Required panes: PRs + next-step + human-in-loop blockers, dependency graph (RFC-0014 snapshot), pipeline journey overview (ideation → production), pipeline config editing, operator usage analytics. Foregrounds decisions-pending per Decision Engine framing. Does not duplicate backlog.md kanban. |
| 0024  | Emergent Issue Capture + Triage Pattern                                                              | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0024-emergent-issue-capture-and-triage.md](RFC-0024-emergent-issue-capture-and-triage.md) | Sidecar mechanism for capturing findings mid-work without breaking flow; triage rubric (quick-fix task vs scope-creep into current work vs new RFC); "decision-pending" → "decision-deferred" handoff so the orchestrator isn't blocked indefinitely. Addresses VISION.md §5 emergent-work gap. |
| 0025  | Framework Quality Monitoring (Non-Decision Failure Modes)                                            | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0025-framework-quality-monitoring.md](RFC-0025-framework-quality-monitoring.md) | Distinguishes "operator under-decided" failures (fix the issue) from "framework misbehaved" failures (fix the framework); auto-routes the latter into bugfix backlog with severity scoring; closes the AISDLC-176-style "valid commit stranded" loop. Operationalizes VISION.md §4 honest failure modes. |
| 0026  | Exploration Workstream Pattern                                                                       | Draft       | Draft        | dominique@reliablegenius.io                                      | [RFC-0026-exploration-workstream-pattern.md](RFC-0026-exploration-workstream-pattern.md) | First-class "spike/research" workstream type that bypasses DoR's decision-frontloading gate (since the goal IS to discover the unknowns); explicit time-box + handoff back to standard execution flow when knowns crystallize. Addresses VISION.md §5 exploration-mode gap. |

| 0027  | Design Coherence Drift Detection                                                                     | Reserved    | Placeholder  | Morgan Hirtle                                                   | (none yet)                                                                        | Design Authority sign-off condition C3 from RFC-0009. Defines DesignCoherenceDrift reconciliation event: fires when delta between soul's design.imperatives and what DSB/component catalog implements exceeds threshold. Fourth Eτ_tessellation_drift detection rule. requires RFC-0009, RFC-0006. |

**Next available number:** RFC-0028.

> **Historical note (RFC-0003 collision):** Two different proposals (`-infrastructure-adapters` and `-product-first-implementation-strategy`) were both numbered 0003. AISDLC-109 resolved the collision by renumbering the product-strategy RFC to RFC-0013; RFC-0003 now refers unambiguously to the infrastructure-adapters RFC. Numbers are NOT recycled — slot collisions are confusing, so withdrawn entries keep their row in the registry.
