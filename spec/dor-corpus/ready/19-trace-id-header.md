## Description
Forward an `X-Request-Id` header on every `/api/v1/issues` request so the orchestrator can correlate logs.

## Acceptance Criteria
- [ ] #1 `POST /api/v1/issues` accepts an `X-Request-Id` header
- [ ] #2 The header value is logged in `orchestrator/src/admission.ts`
- [ ] #3 An integration test in `orchestrator/src/admission.test.ts` asserts forwarding
