## Description
Tighten the `refinement-verdict` schema to forbid `additionalProperties` at the gate level (already true at the document level). The change is in `spec/schemas/refinement-verdict.v1.schema.json`.

## Acceptance Criteria
- [ ] #1 Add `additionalProperties: false` under `gates.items`
- [ ] #2 Update `pipeline-cli/src/dor/types.ts` if the typed shape changes
