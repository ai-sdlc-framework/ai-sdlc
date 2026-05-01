---
id: AISDLC-128
title: >-
  DoR secret-redact cosmetic minors: AWS/PAT trailing-leak, HIGH-ENTROPY
  threshold, private-key markers, doc nit
status: To Do
assignee: []
created_date: '2026-05-01 21:25'
labels:
  - security
  - rfc-0011
  - phase-2b
  - follow-up
  - cosmetic
milestone: m-3
dependencies: []
references:
  - pipeline-cli/src/dor/secret-redact.ts
  - pipeline-cli/src/dor/secret-redact.test.ts
  - pipeline-cli/docs/dor.md
  - >-
    backlog/completed/aisdlc-122 -
    Prevent-secret-persistence-in-DoR-calibration-log-gitignore-artifacts-and-tighten-body-inline-limits.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-122 follow-up bundle (4 cosmetic minors from PR #150 reviews; ship as one task). AISDLC-122 already merged.

1. **AWS_ACCESS_KEY exact-quantifier trailing leak** (`secret-redact.ts:68`): regex uses `{16}` exact rather than `{16,}` or `\b` anchor. When an `AKIA`-prefixed token is followed by extra alphanum (e.g. `AKIAIOSFODNN7EXAMPLEAAAA`), only the first 16 trailing chars are redacted — the suffix `AAAA` leaks. Cosmetic since it's non-secret entropy, but log noise erodes readability.

2. **GITHUB_PAT_FINE exact-quantifier trailing leak** (`secret-redact.ts:63`): same shape — `{82}` exact instead of `{82,}` or word boundary. `github_pat_<90 chars>` becomes `[REDACTED:GITHUB_PAT_FINE]<8 trailing>`.

3. **HIGH-ENTROPY threshold raise** (`secret-redact.ts:80`): `[A-Za-z0-9_-]{40,}` triggers on common non-secret content found in DoR finding text — branch names like `aisdlc-122-prevent-secret-persistence-with-three-layer-defense`, hyphenated PR titles, commit SHAs in markdown links. The whole point of the calibration log is human-readable spot-checking; redacting half the branch/PR refs erodes usefulness fast. Consider raising to 48 or 56 chars OR requiring at least one digit.

4. **Private-key BEGIN/END markers** (`secret-redact.ts`): `-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----` is high-signal with zero realistic false positives. Pasted private-key body is partially caught by HIGH-ENTROPY (each base64 line is 64 alphanumeric chars), but the BEGIN/END headers themselves persist verbatim and uniquely identify the block as a private key.

5. **Doc nit** (`pipeline-cli/docs/dor.md`): the "Calibration log secret hygiene" section lists redaction targets as title / bodyPreview / per-gate finding+clarificationQuestion / summary / questions[]. The implementation also redacts the `notes` field. Add `notes` to the bullet list for completeness.

6. **JWT regex anchor-intent comment** (`secret-redact.ts:73`): JWT pattern requires the second segment to also start with `eyJ` (intentional false-positive control — JWT alg/typ headers always base64url-encode to `eyJ`). Add a comment so future maintainers don't relax it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AWS_ACCESS_KEY regex uses {16,} OR \b anchor; trailing-alphanum smoke test added
- [ ] #2 GITHUB_PAT_FINE regex uses {82,} OR \b anchor; trailing-alphanum smoke test added
- [ ] #3 HIGH-ENTROPY threshold raised (decide 48 vs 56 OR require ≥1 digit); branch-name + commit-SHA + PR-title test cases added asserting they stay intact
- [ ] #4 PRIVATE_KEY_BLOCK pattern added; multi-line BEGIN-END test case
- [ ] #5 pipeline-cli/docs/dor.md "Calibration log secret hygiene" bullet list adds `notes`
- [ ] #6 JWT pattern has an inline comment explaining the second-segment `eyJ` anchor is intentional
<!-- AC:END -->
