---
id: AISDLC-128
title: >-
  DoR secret-redact cosmetic minors: AWS/PAT trailing-leak, HIGH-ENTROPY
  threshold, private-key markers, doc nit
status: Done
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
- [x] #1 AWS_ACCESS_KEY regex uses {16,} OR \b anchor; trailing-alphanum smoke test added
- [x] #2 GITHUB_PAT_FINE regex uses {82,} OR \b anchor; trailing-alphanum smoke test added
- [x] #3 HIGH-ENTROPY threshold raised (decide 48 vs 56 OR require ≥1 digit); branch-name + commit-SHA + PR-title test cases added asserting they stay intact
- [x] #4 PRIVATE_KEY_BLOCK pattern added; multi-line BEGIN-END test case
- [x] #5 pipeline-cli/docs/dor.md "Calibration log secret hygiene" bullet list adds `notes`
- [x] #6 JWT pattern has an inline comment explaining the second-segment `eyJ` anchor is intentional
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
6 cosmetic minors from AISDLC-122 + AISDLC-126 reviews shipped as one bundle. Trailing-leak word-boundary fixes on AWS_ACCESS_KEY/GITHUB_PAT (classic + fine)/TWILIO_SID/MAILGUN/GCP_API_KEY (greedy `{N,}` quantifiers stop trailing alphanum from leaking past the marker). New PRIVATE_KEY_BLOCK pattern catching `-----BEGIN ... PRIVATE KEY -----` headers. HIGH-ENTROPY threshold raised 40→48 + requires-digit lookahead (reduces branch-name false positives at ~10% recall cost on shorter alphanum-only secrets). JWT eyJ-anchor intent comment. Doc nit added `notes` field.

## Changes
- `pipeline-cli/src/dor/secret-redact.ts`: greedy quantifier on 6 patterns; new PRIVATE_KEY_BLOCK; HIGH-ENTROPY 40→48 + digit-required lookahead; honest rationale comment about numbered AISDLC branches; JWT anchor intent comment
- `pipeline-cli/src/dor/secret-redact.test.ts`: 17 new test cases (5 trailing-leak smoke tests, 6 PRIVATE_KEY_BLOCK tests, JWT anchor anti-regression, HIGH-ENTROPY threshold tests, numbered AISDLC branch + digit-free branch trade-off tests, GITHUB_PAT classic trailing-leak, PRIVATE_KEY_BLOCK explicit idempotency lock); 72 tests total
- `pipeline-cli/docs/dor.md`: pattern catalogue table updated for all 6 quantifier changes + PRIVATE_KEY_BLOCK row + `notes` field added to redacted-fields list

## Iteration history
- **Round 1** (commit `fb8a242`): all 8 ACs met. Reviews: code 0c/1M/4m/2s, test 0c/0M/0m/2s, security 0c/0M/0m/2s. The 1 MAJOR was the HIGH-ENTROPY rationale comment claiming branch names stay intact while real `aisdlc-NNN-...` branches DO get redacted (digit anywhere triggers the lookahead).
- **Round 2** (commit `4297531`, amend): MAJOR fixed via Option A (honest comment) — option B (regex tightening to require digit in first 8 chars) was rejected because the reviewer's own analysis showed AISDLC-NNN digits land in the first 9 chars regardless. Also extended GITHUB_PAT classic to greedy `{36,}` for cohort consistency, added numbered-AISDLC-branch + GITHUB_PAT-classic-trailing + PRIVATE_KEY_BLOCK-idempotency tests. Reviews: code 0c/0M/1m/1s (doc-drift on dor.md `GITHUB_PAT` row, fixed inline pre-finalize), test 0c/0M/0m/0s, security 0c/0M/0m/0s.

## Verification
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- secret-redact.ts: 100% line / 100% branch coverage
- 72 secret-redact tests pass; full pipeline-cli suite 554 pass; full workspace test suite exits 0
- 6 reviews APPROVED across 2 iterations (`⚠ INDEPENDENCE NOT ENFORCED — codex unavailable`)

## Follow-up (deferred to separate task)
- **PRIVATE_KEY_BLOCK ENCRYPTED variant** (security suggestion): add `ENCRYPTED ` to the type alternation so password-protected PKCS#8 blocks redact too
- **PRIVATE_KEY_BLOCK asymmetric BEGIN/END type prefix tightening** (code minor): use back-reference to require matching prefixes
- **AWS secret access key recall regression** (security suggestion): the 40-char standalone case (no `AKIA` partner key alongside) used to match HIGH-ENTROPY at the old 40 floor and now slips past 48; consider context-aware AWS_SECRET_ACCESS_KEY pattern or update the source comment
- **HIGH-ENTROPY lookahead anchor-intent inline comment** (code minor): partly addressed by the round-2 MAJOR fix
- **Numbered-AISDLC-branch test "passes for the wrong reason"** (code suggestion): the segmentation-vs-digit-rule test rationalization could be tightened
- **Note**: AISDLC-128's chain on AISDLC-126 (PR #154) means this PR is stacked. Will rebase onto fresh main after #154 merges.
<!-- SECTION:FINAL_SUMMARY:END -->
