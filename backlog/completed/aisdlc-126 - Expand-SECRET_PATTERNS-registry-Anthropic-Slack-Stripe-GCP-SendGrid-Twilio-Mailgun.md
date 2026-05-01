---
id: AISDLC-126
title: >-
  Expand SECRET_PATTERNS registry: Anthropic, Slack, Stripe, GCP, SendGrid,
  Twilio, Mailgun
status: Done
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
- [x] #1 New SECRET_PATTERNS entries: ANTHROPIC, SLACK, STRIPE_LIVE_SECRET, STRIPE_LIVE_PUBLISHABLE, STRIPE_WEBHOOK, GCP_API_KEY, SENDGRID, TWILIO_SID, MAILGUN
- [x] #2 Each entry has a positive test case (real-shaped fake token redacted) AND a negative test case (similar non-secret string unchanged)
- [x] #3 Pattern ordering: specific entries before HIGH-ENTROPY so specific markers win
- [x] #4 Idempotency test: redactSecrets(redactSecrets(s)) === redactSecrets(s) (locks the property that markers don't re-trigger redaction)
- [x] #5 Docs updated: pipeline-cli/docs/dor.md "Calibration log secret hygiene" lists all covered patterns
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Adds 9 new SECRET_PATTERNS entries (ANTHROPIC, SLACK, STRIPE_LIVE_SECRET, STRIPE_LIVE_PUBLISHABLE, STRIPE_WEBHOOK, GCP_API_KEY, SENDGRID, TWILIO_SID, MAILGUN) layered ahead of the generic HIGH-ENTROPY catch-all so specific markers win. Closes the gap from AISDLC-122 reviews where Stripe `sk_live_<24>` and Slack 32-hex secrets fell below the 40-char HIGH-ENTROPY threshold.

## Changes
- `pipeline-cli/src/dor/secret-redact.ts`: 9 new entries in `SECRET_PATTERNS`, ordered specific-before-generic
- `pipeline-cli/src/dor/secret-redact.test.ts`: per-pattern positive + negative tests; exhaustive idempotency loop over all 16 registered patterns
- `pipeline-cli/docs/dor.md`: pattern catalogue updated with all 16 markers

## Verification
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- secret-redact.ts: 100% line / 100% branch coverage; 5,416 workspace tests pass
- 3 reviews APPROVED (`⚠ INDEPENDENCE NOT ENFORCED — codex unavailable`): code 0c/0M/1m/2s; test 0c/0M/2m/2s; security 0c/0M/2m/3s

## Follow-up
- **Slack pattern coverage** (security minor): `xox[abprs]-` misses `xoxc` (config), `xoxe` (refresh), `xoxo` (workflow). Broaden to `xox[a-z]-` or enumerate `[abceoprs]` — fold into AISDLC-128 or new task.
- **GCP fixed `{35}` trailing-leak** (security minor): same shape as AISDLC-128's AWS `{16}` concern (HIGH-ENTROPY backstop needs ≥40 chars; 39-char GCP keys + extra trailing chars slip out unredacted). Fold into AISDLC-128 with the AWS+TWILIO+MAILGUN cohort.
- **Stripe `sk_test_` exclusion policy** (security minor): test asserts test-mode keys NOT redacted by design, but the policy is only encoded in a test name. Add explicit docstring + dor.md note so future maintainers don't "fix" by broadening the regex.
- **Anthropic future variants** (security suggestion): hardcoded `(?:api03|admin01)` — `api04` would fall through to HIGH-ENTROPY. Consider variant-tolerant `sk-ant-[a-z0-9]+-` brand-prefix anchor.
- **Test boundary precision** (test minor): N-1 vs N exact length boundary tests on Slack `{10,}`, Stripe `{20,}`, HIGH-ENTROPY `{40,}` — file as test follow-up if worth the noise.
<!-- SECTION:FINAL_SUMMARY:END -->
