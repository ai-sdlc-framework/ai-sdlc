---
# Canonical RFC identifier. MUST match the filename prefix
# (e.g. `RFC-0006-design-system-governance-v5-final.md` → `id: RFC-0006`).
id: RFC-NNNN

# Human-readable title (no `RFC-NNNN:` prefix — that's encoded in `id`).
title: Title

# Legacy status enum (retained for back-compat with `scripts/check-rfc-docs.mjs`).
# Prefer the `lifecycle` field below for new RFCs — it captures the per-owner
# sign-off + implementation arc more precisely. One of:
#   Draft        — being written by the author
#   Under Review — open for community discussion / SIG review
#   Approved     — sign-off complete, spec update pending
#   Implemented  — merged into the normative spec documents
#   Final        — terminal pre-implementation status for sign-off-gated RFCs
#                  (RFC-0006, RFC-0008): spec is locked but reference
#                  implementations are still in flight
#   Rejected     — reviewed and rejected
#   Withdrawn    — withdrawn by the author
status: Draft

# AISDLC-118 lifecycle field — separate from the per-owner sign-off checklist
# in the body. Drafts SHOULD land on main as soon as the author considers
# them shareable so stakeholders can link to the canonical URL; sign-off no
# longer gates visibility. One of:
#   Draft            — initial brainstorm; structure may shift; sign-off
#                      boxes empty
#   Ready for Review — structure stable; at least one owner signed; awaiting
#                      remaining owners
#   Signed Off       — all owners signed; design locked
#   Implemented      — corresponding milestone reached Done
#   Superseded       — replaced by a newer RFC (header notes the successor)
lifecycle: Draft

# Primary author name(s). Comma-separated for multi-author RFCs.
author: '[Name]'

# ISO 8601 dates (YYYY-MM-DD).
created: YYYY-MM-DD
updated: YYYY-MM-DD

# Spec API version this RFC targets. Optional but recommended.
targetSpecVersion: v1alpha1

# Dependency declarations (AISDLC-311 — split semantics):
#
#   requires:  Runtime-code dependency — this RFC's implementation IMPORTS code
#              from the listed RFC(s) implementations. They MUST ship (lifecycle
#              `Implemented`) before this RFC's implementation can ship.
#              Example: RFC-0035 Phase 5 imports the shared classifier substrate
#              from RFC-0024 Refit Phase 2 → `requires: [RFC-0024]`.
#
#   assumes:   Design-contract dependency — this RFC reads the listed RFC(s)
#              as a design contract (type shape, schema, naming, semantics) but
#              does NOT code-import their implementation. They only need to
#              EXIST at `Ready for Review` or higher — they do NOT need to ship
#              before this RFC's implementation can ship.
#              Example: RFC-0031 assumes the DID schema from RFC-0009 but only
#              takes abstract `IdentityClass + fieldPath` parameters; callers
#              will provide the RFC-0009-resolved values once RFC-0009 ships.
#              → `assumes: [RFC-0005, RFC-0008, RFC-0009, RFC-0029, RFC-0030]`.
#
# When in doubt: if removing the dependency would cause a TypeScript / Node
# import error, it's `requires:`; if removing it would only leave a comment
# stale, it's `assumes:`. The DoR upstream-OQ gate only BLOCKS task dispatch
# on `requires:` entries; `assumes:` entries are documentation.
#
# requires: [RFC-0002, RFC-0004]
# assumes: [RFC-0009]
# amends: [RFC-0002]
#
# Optional: the source-tree paths that implement this RFC. When declared, the
# docs-drift linter cross-checks `requires:` entries against actual imports
# from these files; missing imports surface a deprecation warning suggesting
# `assumes:`. Omit when the RFC has no implementation yet (Draft / Ready for
# Review with deferred impl).
# implementedBy:
#   - orchestrator/src/sa-scoring/revision-proposal.ts

# Closed enum declaring which user-facing doc surfaces must reference this RFC.
# Allowed values (each maps to a `docs/` subdirectory):
#   tutorial          → docs/tutorials/
#   operator-runbook  → docs/operations/
#   api-reference     → docs/api-reference/
#   getting-started   → docs/getting-started/
#   example           → docs/examples/
#
# CI (AISDLC-69.3) enforces that for each value here, at least one file in the
# corresponding subdirectory references this RFC by `id` (literal text, e.g.
# `RFC-0006`). An empty array `[]` is valid for purely strategic/conceptual
# RFCs (e.g. product strategy) and disables the check — the RFC body SHOULD
# explain why no user docs are required.
requiresDocs: []

# Escape hatch for RFCs whose required surfaces are intentionally deferred.
# When `deferredDocs: true`, `deferredDocsDeadline: YYYY-MM-DD` MUST also be
# set. CI passes but logs a warning that grows louder as the deadline
# approaches. (Deadline enforcement is informational in v1.)
# deferredDocs: false
# deferredDocsDeadline: YYYY-MM-DD
---

# RFC-NNNN: Title

**Status:** Draft
**Lifecycle:** Draft
**Author:** [Name]
**Created:** YYYY-MM-DD
**Updated:** YYYY-MM-DD
**Target Spec Version:** v1alpha1

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).
>
> **AISDLC-118 — drafts land on main early.** As soon as you consider this
> RFC shareable (typically after the first internal pass), open a PR that
> lands it on main with `lifecycle: Draft`. Stakeholders can then reference
> it at the canonical `spec/rfcs/RFC-NNNN-*.md` URL while you iterate. Sign-
> off no longer gates visibility — flip `lifecycle` as the design matures
> (Draft → Ready for Review → Signed Off → Implemented).

---

## Summary

A brief (1-2 paragraph) description of the proposed change.

## Motivation

Why is this change needed? What problem does it solve? Include specific pain points, use cases, or data that motivate the proposal.

## Goals

- Goal 1
- Goal 2

## Non-Goals

- Non-goal 1 (explicitly out of scope)
- Non-goal 2

## Proposal

Detailed description of the proposed change. Include:

- New or modified resource fields with types and validation rules
- Updated schema definitions (JSON Schema fragments)
- Modified normative requirements (with RFC 2119 language)
- YAML examples showing the proposed configuration

## Design Details

### Schema Changes

Show the relevant JSON Schema additions or modifications.

```json
{
  "properties": {
    "newField": {
      "type": "string",
      "description": "Description of the new field."
    }
  }
}
```

### Behavioral Changes

Describe any changes to reconciliation behavior, evaluation semantics, or enforcement logic.

### Migration Path

If this is a breaking change, describe the migration path from the current behavior to the proposed behavior.

## Backward Compatibility

Describe the backward compatibility implications:

- Is this a breaking change?
- Can existing resources be validated against the updated schema without modification?
- What is the migration path for existing implementations?

## Alternatives Considered

Describe alternative approaches that were considered and why they were rejected.

### Alternative 1: [Name]

Description and rationale for rejection.

### Alternative 2: [Name]

Description and rationale for rejection.

## Implementation Plan

- [ ] Update normative spec document(s)
- [ ] Update JSON Schema(s)
- [ ] Update glossary (if new terms introduced)
- [ ] Update primer (if architectural changes)
- [ ] Reference implementation proof-of-concept
- [ ] Conformance test updates
- [ ] Author/update each user-facing doc surface declared in `requiresDocs`

## Open Questions

1. Question 1?
2. Question 2?

## References

- [Link to relevant issue or discussion]
- [Link to prior art or related work]
