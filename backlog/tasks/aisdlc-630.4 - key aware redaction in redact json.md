---
id: AISDLC-630.4
title: >-
  RFC-0049 follow-up (security): key-aware redaction of values under secret-named keys in the judgment state redactor
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - security
  - judgment-layer
dependencies:
  - AISDLC-630.2
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/redact-json.ts
  - reference/src/security/secret-redact.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from the security review of AISDLC-630.2 (#1143), approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM, hermetic
tests, fixtures only ever contain fake secrets). AISDLC-641 depends on this task, so no
judgment provider is enabled while it is open.

## Scope
The judgment runtime applies `redactSecrets` to every string value in the state
(`reference/src/judgment/redact-json.ts`), which catches secrets by their own shape
but not a plain value stored under a secret-named key (for example
`{"password": "hunter2"}` or `{"apiKey": "x"}`).
1. In `redact-json.ts`, redact the whole value of any object key whose name matches
   the secret-bearing key list shared with `secret-redact.ts` (one exported list, not
   two), at any nesting depth, for string, number and array-of-string values.
2. Keys are matched case-insensitively and across `_`, `-` and camel-case separators.
3. Values under non-secret keys keep the existing shape-based redaction only.
4. Export the key list from `secret-redact.ts` so both modules read the same source.

## Acceptance Criteria
- [ ] A nested object with `password`, `api-key`, `apiKey`, `secret_token` and `credentials` keys has every such value redacted regardless of the value's shape, in string, number and array forms.
- [ ] A value under a non-secret key that matches no shape is left unchanged, and one that matches a shape is still redacted.
- [ ] Both modules import the key list from one exported constant (asserted by a test that the lists are identical).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
