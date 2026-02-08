# RFC-NNNN: Title

**Status:** Draft
**Author:** [Name]
**Created:** YYYY-MM-DD
**Updated:** YYYY-MM-DD
**Target Spec Version:** v1alpha1

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

## Open Questions

1. Question 1?
2. Question 2?

## References

- [Link to relevant issue or discussion]
- [Link to prior art or related work]
