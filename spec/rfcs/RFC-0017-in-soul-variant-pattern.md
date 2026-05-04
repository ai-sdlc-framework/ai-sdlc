---
id: RFC-0017
title: In-Soul Variant Pattern
status: Draft
lifecycle: Draft
author: morgan@sprypoint.com
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0009
requiresDocs: []
---

# RFC-0017: In-Soul Variant Pattern

**Document type:** Normative (draft)
**Status:** Draft v0.1 — Initial stub. Full spec pending practitioner validation pass against SpryPoint four-soul platform (SpryEngage / SpryMobile / SpryCIS / SpryBackflow).
**Created:** 2026-05-04
**Authors:** Morgan Hirtle (Design Authority, SpryPoint)
**Requires:** RFC-0009 (Tessellated Design Intent Documents)

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Morgan Hirtle | Chief of Design / Design Authority | ✍️ Authored v0.1 | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ⏸ Pending | — |
| Alexander Kline | Head of Product Strategy / Product Authority | ⏸ Pending | — |

---

## 1. Summary

A Variant is a soul-scoped sub-theme within a Soul DID: a named configuration that carries distinct visual identity specializations and audience targeting while inheriting the parent Soul DID's foundational triad and compliance regime.

This RFC defines the In-Soul Variant Pattern — how variants are declared, how they inherit from their parent Soul DID, and how the admission composite scores work items that target a specific variant rather than the full soul.

**Practitioner validation source:** SpryPoint's four-product suite (SpryEngage, SpryMobile, SpryCIS, SpryBackflow) provides the reference implementation. Each product is a distinct soul on shared substrate; each soul contains audience-specific variants requiring independent design intent declaration while sharing the soul's compliance floor and design system tokens.

Full normative spec to follow after practitioner validation pass.

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

- [RFC-0009 Tessellated Design Intent Documents](RFC-0009-tessellated-design-intent-documents.md)
