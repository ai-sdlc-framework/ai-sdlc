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

## RFC Lifecycle

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

| Status | Description |
| --- | --- |
| `Draft` | RFC is being written by the author |
| `Under Review` | RFC is open for community discussion and SIG review |
| `Approved` | RFC has been approved; spec update pending |
| `Implemented` | RFC has been merged into the specification |
| `Rejected` | RFC was reviewed and rejected |
| `Withdrawn` | RFC was withdrawn by the author |

## File Naming

RFC files follow the pattern:

```
RFC-NNNN-short-title.md
```

- `NNNN` is a zero-padded sequential number
- `short-title` is a lowercase, hyphenated summary (e.g., `custom-resource-types`)

## Index

| RFC | Title | Status |
| --- | --- | --- |
| [RFC-0001](RFC-0001-template.md) | Template | — |
| [RFC-0002](RFC-0002-pipeline-orchestration.md) | Pipeline Orchestration Policy | Draft |
| [RFC-0003](RFC-0003-infrastructure-adapters.md) | Infrastructure Provider Adapters | Draft |
| [RFC-0004](RFC-0004-cost-governance-and-attribution.md) | Cost Governance and Attribution | Draft |
| [RFC-0005](RFC-0005-product-priority-algorithm.md) | Product Priority Algorithm (PPA) | Draft |
| [RFC-0006](RFC-0006-design-system-governance-v5-final.md) | Design System Governance | Draft |
| [RFC-0008](RFC-0008-ppa-triad-integration-final-combined.md) | PPA Triad Integration | Draft |
| [RFC-0009](RFC-0009-tessellated-design-sharding.md) | Tessellated Design Sharding | Draft |
| [RFC-0010](RFC-0010-parallel-execution-worktree-pooling.md) | Parallel Execution and Worktree Pooling | Draft |
