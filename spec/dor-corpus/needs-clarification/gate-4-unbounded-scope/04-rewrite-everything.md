## Description
Rewrite the whole admission pipeline at `orchestrator/src/admission.ts` from scratch using the new `@ai-sdlc/pipeline-cli` primitives.

## Acceptance Criteria
- [ ] #1 `orchestrator/src/admission.ts` no longer contains any of the legacy code paths
- [ ] #2 Every consumer in `orchestrator/src/` is migrated
- [ ] #3 The test suite in `orchestrator/src/admission.test.ts` is rewritten end-to-end
