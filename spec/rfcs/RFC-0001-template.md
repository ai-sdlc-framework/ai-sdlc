---
# Canonical RFC identifier. MUST match the filename prefix
# (e.g. `RFC-0006-design-system-governance-v5-final.md` → `id: RFC-0006`).
id: RFC-NNNN

# Human-readable title (no `RFC-NNNN:` prefix — that's encoded in `id`).
title: Title

# Lifecycle status. One of:
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

# Primary author name(s). Comma-separated for multi-author RFCs.
author: '[Name]'

# ISO 8601 dates (YYYY-MM-DD).
created: YYYY-MM-DD
updated: YYYY-MM-DD

# Spec API version this RFC targets. Optional but recommended.
targetSpecVersion: v1alpha1

# Other RFC IDs this RFC depends on / amends. Optional.
# requires: [RFC-0002, RFC-0004]
# amends: [RFC-0002]

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
**Author:** [Name]
**Created:** YYYY-MM-DD
**Updated:** YYYY-MM-DD
**Target Spec Version:** v1alpha1

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).

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
