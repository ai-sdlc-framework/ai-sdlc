---
id: AISDLC-630.2
title: >-
  RFC-0049 follow-up: close redactSecrets gaps (40-char AWS secrets, URL credentials, .env-style assignments)
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - security
  - judgment-layer
dependencies:
  - AISDLC-630
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/security/secret-redact.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security review of AISDLC-630 rated this a priority: once a judgment provider is
named, `work-item-text` leaves the machine by default (RFC-0049 OQ-2), and the
redactor applied before egress misses three common secret shapes. Must land before
AISDLC-641 enables a provider.

## Scope
Extend `SECRET_PATTERNS` in the module now at `reference/src/security/secret-redact.ts`
(re-exported from its old `pipeline-cli` path):
1. AWS secret access keys: 40-character base64-alphabet tokens adjacent to an AWS
   access key id or to a key name containing `secret`.
2. URL userinfo credentials: `scheme://user:password@host` redacts the password (and
   the user when it looks like a token).
3. `.env`-style assignments: `NAME=value` where NAME contains `SECRET`, `TOKEN`,
   `PASSWORD`, `PASSWD`, `API_KEY`, `PRIVATE_KEY` or `CREDENTIAL` (case-insensitive),
   redacting the value only.
Keep the registry order documented; add fixtures for each pattern and negative
fixtures for look-alikes that must not be redacted (short base64 words, URLs without
userinfo, `KEY=value` with a non-secret name).

## Acceptance Criteria
- [ ] Each of the three shapes is redacted in a fixture, leaving surrounding text intact.
- [ ] The negative fixtures are left unchanged.
- [ ] Every existing redaction test passes unmodified.
- [ ] `redactSecrets` applied to a JSON state object (as the judgment runtime does) redacts nested string values of all three shapes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
