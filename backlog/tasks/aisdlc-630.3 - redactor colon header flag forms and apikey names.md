---
id: AISDLC-630.3
title: >-
  RFC-0049 follow-up (security): redact colon, header and flag secret forms, APIKEY names, raw URL password characters and multi-token values
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
Extend `SECRET_PATTERNS` in `reference/src/security/secret-redact.ts` to redact, with a
positive and a negative fixture for each form:
1. Colon forms: `POSTGRES_PASSWORD: x` and `"password":"x"` (YAML and JSON), for the
   same secret-bearing key names the `.env` rule uses.
2. Header forms: `Authorization: Bearer <token>`, `Authorization: Basic <token>`,
   `X-Api-Key: <value>`, `Cookie:` values whose names look like session or auth
   tokens.
3. Flag forms: `--password x`, `--password=x`, `-p x` after a database client name,
   `curl -u user:pw` and `--user user:pw`.
4. Names `APIKEY` and `apiKey` (and `api-key`) in every form above, in addition to
   `API_KEY`.
5. URL credentials with raw `/`, `#` or `?` inside the password and `@` inside the
   user, which the existing URL rule stops at.
6. Unquoted multi-token values after a secret-named key up to end of line or the next
   whitespace-separated `KEY=` pair.
Keep the documented registry order; existing redaction tests pass unmodified.

## Acceptance Criteria
- [ ] Each of the six forms is redacted in its fixture, leaving the key name and surrounding text intact.
- [ ] Each negative fixture (a non-secret key with the same shape, a header that carries no credential, a URL without userinfo) is left unchanged.
- [ ] Existing redaction tests pass unmodified.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
