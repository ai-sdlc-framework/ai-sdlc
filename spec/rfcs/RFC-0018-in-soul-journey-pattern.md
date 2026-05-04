---
id: RFC-0018
title: In-Soul Journey Pattern
status: Draft
lifecycle: Draft
author: morgan@reliablegenius.io
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0009
  - RFC-0017
requiresDocs: []
---

# RFC-0018: In-Soul Journey Pattern

**Document type:** Normative (draft)
**Status:** Draft v0.1 — Initial stub. Full spec pending practitioner validation pass against InternalAdopter accessibility audit pipeline.
**Created:** 2026-05-04
**Authors:** Morgan Hirtle (Design Authority, InternalAdopter)
**Requires:** RFC-0009 (Tessellated Design Intent Documents), RFC-0017 (In-Soul Variant Pattern)

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

A Journey is a temporally-ordered user flow within a Soul DID (or within a Variant per RFC-0017): a named sequence of states and transitions that carries distinct design intent, completion criteria, and success metrics at the soul level.

This RFC defines the In-Soul Journey Pattern — how journeys are declared on a Soul DID, how they relate to Variants (RFC-0017), and how the admission composite prioritizes work items that advance, repair, or complete a specific journey.

**Practitioner validation source:** A utility software platform's accessibility audit pipeline provides the reference implementation. The WCAG 2.1 AA audit surface maps naturally to journey-level design intent: each product flow is a journey with distinct completion criteria and accessibility requirements that cannot be collapsed to soul-level aggregate scoring without losing precision.

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
- [RFC-0017 In-Soul Variant Pattern](RFC-0017-in-soul-variant-pattern.md)
