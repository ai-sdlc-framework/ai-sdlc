---
id: AISDLC-126
title: >-
  Expand SECRET_PATTERNS registry: Anthropic, Slack, Stripe, GCP, SendGrid,
  Twilio, Mailgun
status: To Do
assignee: []
created_date: '2026-05-01 21:24'
labels:
  - security
  - rfc-0011
  - phase-2b
  - follow-up
milestone: m-3
dependencies: []
references:
  - pipeline-cli/src/dor/secret-redact.ts
  - pipeline-cli/src/dor/secret-redact.test.ts
  - pipeline-cli/docs/dor.md
  - >-
    backlog/completed/aisdlc-122 -
    Prevent-secret-persistence-in-DoR-calibration-log-gitignore-artifacts-and-tighten-body-inline-limits.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-122 follow-up (security minor finding from PR #150 reviews). AISDLC-122 already merged.

The initial `SECRET_PATTERNS` registry in `pipeline-cli/src/dor/secret-redact.ts` covers OpenAI, GitHub PATs, AWS access keys, JWTs, and a generic high-entropy fallback. Several common credential formats slip through:

- **Anthropic API keys** (`sk-ant-api03-...`, `sk-ant-admin01-...`): the OpenAI `sk-[A-Za-z0-9]{20,}` regex matches only `sk-ant` (4 chars) before bailing on the hyphen, and the recognisable `sk-ant-` prefix gets preserved in the log.
- **Slack tokens** (`xox[abprs]-...`): no pattern.
- **Stripe live keys** (`sk_live_...`, `pk_live_...`, `whsec_...`): no pattern; the `sk_live_<24>` form falls below the 40-char HIGH-ENTROPY threshold.
- **GCP API keys** (`AIza[0-9A-Za-z_-]{35}`): no pattern.
- **SendGrid** (`SG.<22>.<43>`), **Twilio account SIDs** (`AC<32-hex>`), **Mailgun** (`key-<32-hex>`): no patterns.

Add explicit registry entries ahead of the HIGH-ENTROPY catch-all so each format gets a meaningful redaction marker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New SECRET_PATTERNS entries: ANTHROPIC, SLACK, STRIPE_LIVE_SECRET, STRIPE_LIVE_PUBLISHABLE, STRIPE_WEBHOOK, GCP_API_KEY, SENDGRID, TWILIO_SID, MAILGUN
- [ ] #2 Each entry has a positive test case (real-shaped fake token redacted) AND a negative test case (similar non-secret string unchanged)
- [ ] #3 Pattern ordering: specific entries before HIGH-ENTROPY so specific markers win
- [ ] #4 Idempotency test: redactSecrets(redactSecrets(s)) === redactSecrets(s) (locks the property that markers don't re-trigger redaction)
- [ ] #5 Docs updated: pipeline-cli/docs/dor.md "Calibration log secret hygiene" lists all covered patterns
<!-- AC:END -->
