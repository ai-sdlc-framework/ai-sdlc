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

## Index

| RFC                                                                              | Title                                  | Lifecycle    | Status      | requiresDocs                                  |
| -------------------------------------------------------------------------------- | -------------------------------------- | ------------ | ----------- | --------------------------------------------- |
| [RFC-0001](RFC-0001-template.md)                                                 | Template                               | —            | —           | —                                             |
| [RFC-0002](RFC-0002-pipeline-orchestration.md)                                   | Pipeline Orchestration Policy          | Draft        | Draft       | tutorial, api-reference, example              |
| [RFC-0003](RFC-0003-infrastructure-adapters.md)                                  | Infrastructure Provider Adapters       | Draft        | Draft       | tutorial, api-reference, operator-runbook, example |
| [RFC-0004](RFC-0004-cost-governance-and-attribution.md)                          | Cost Governance and Attribution        | Draft        | Draft       | tutorial, api-reference, operator-runbook     |
| [RFC-0005](RFC-0005-product-priority-algorithm.md)                               | Product Priority Algorithm (PPA)       | Draft        | Draft       | api-reference, operator-runbook               |
| [RFC-0006](RFC-0006-design-system-governance-v5-final.md)                        | Design System Governance               | Implemented  | Final       | tutorial, operator-runbook, api-reference     |
| [RFC-0008](RFC-0008-ppa-triad-integration-final-combined.md)                     | PPA Triad Integration                  | Implemented  | Final       | api-reference, operator-runbook               |
| [RFC-0010](RFC-0010-parallel-execution-worktree-pooling.md)                      | Parallel Execution and Worktree Pooling| Implemented  | Draft       | operator-runbook, api-reference               |
| [RFC-0011](RFC-0011-definition-of-ready-gate.md)                                 | Definition-of-Ready Gate               | Signed Off   | Draft       | _(none — phased rollout)_                     |
| [RFC-0012](RFC-0012-two-tier-pipeline-architecture.md)                           | Two-Tier Pipeline Architecture         | Signed Off   | Approved    | _(none — internal architecture)_              |
| [RFC-0013](RFC-0013-product-first-implementation-strategy.md)                    | AI-SDLC Orchestrator Product Strategy  | Draft        | Draft       | _(none — strategic)_                          |
| [RFC-0014](RFC-0014-dependency-graph-composition.md)                             | Dependency Graph Composition           | Draft        | Draft       | _(none — phased rollout)_                     |

> **Note:** RFC-0007 and RFC-0009 are reserved / withdrawn slots — their RFCs were folded into RFC-0006 (Figma Make scope) and RFC-0008 (sharding model) respectively, and their files were never finalised.
> RFC-0003 was previously a slot collision — two different proposals (`-infrastructure-adapters` and `-product-first-implementation-strategy`) were both numbered 0003. The collision was resolved in AISDLC-109 by renumbering the product-strategy RFC to RFC-0013; RFC-0003 now refers unambiguously to the infrastructure-adapters RFC.
