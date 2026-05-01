---
id: AISDLC-122
title: >-
  Prevent secret persistence in DoR calibration log: gitignore artifacts/ and
  tighten body-inline limits
status: Done
assignee: []
created_date: '2026-05-01 20:18'
labels:
  - security
  - rfc-0011
  - phase-2b
  - follow-up
milestone: m-3
dependencies:
  - AISDLC-115.3
references:
  - pipeline-cli/src/dor/calibration-log.ts
  - .gitignore
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#5.5
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-115.3 security follow-up (minor finding, real risk under existing pipeline policy).

`pipeline-cli/src/dor/calibration-log.ts` `resolveCalibrationLogPath()` defaults to `./artifacts/_dor/calibration.jsonl`, and the repo `.gitignore` does NOT cover `artifacts/`. `buildEntry()` inlines the full issue title and short bodies (≤500 chars) verbatim as `bodyPreview`, plus the full `RefinementVerdict` including LLM-derived `finding` / `clarificationQuestion` strings (which may quote the body).

Combined with the project's pipeline practice of `git add -A` (per `feedback_stash_completely_before_pipelines.md`), a user who pastes an API key/token into a short issue body or title would commit it to git history through this log.

Three layered mitigations recommended; ship at least #1, prefer all three.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Add `artifacts/` (or specifically `artifacts/_dor/`) to repo `.gitignore`
- [x] #2 Lower `BODY_INLINE_LIMIT` in calibration-log.ts so even short bodies switch to `bodySha` (e.g. drop from 500 chars to 80 chars; verify no test breakage from shorter inline)
- [x] #3 Add a regex-based secret-redact pass over `title` + `bodyPreview` + LLM `finding`/`clarificationQuestion` strings before write; covers common patterns (`sk-...`, `ghp_...`, `AKIA...`, JWTs, generic `[A-Za-z0-9_-]{40,}` warnings)
- [x] #4 Unit test asserting a known fake token (e.g. `sk-test-abcdef1234567890abcdef1234567890`) in the issue body is redacted in the persisted JSONL entry
- [x] #5 Document the hardening in `pipeline-cli/docs/dor.md` under a 'Calibration log secret hygiene' section
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
3-layer defense against pasted secrets persisting through the DoR calibration log: `.gitignore` covers `artifacts/`, `BODY_INLINE_LIMIT` dropped 500 → 80 chars, and a new `pipeline-cli/src/dor/secret-redact.ts` module provides a `SECRET_PATTERNS` registry + `redactSecrets()` applied to title, bodyPreview, per-gate finding/clarificationQuestion, summary, questions, and notes before JSONL serialization.

## Changes
- `.gitignore` (modified): add `artifacts/` (catches every directory named `artifacts/` in the tree)
- `pipeline-cli/src/dor/secret-redact.ts` (new): `SECRET_PATTERNS` registry + `redactSecrets()` — covers OpenAI sk-, OpenAI sk-proj-, GitHub PAT classic + fine-grained, AWS access key, JWT, generic high-entropy 40+
- `pipeline-cli/src/dor/secret-redact.test.ts` (new): per-pattern positive + negative tests + 80/81-char boundary case
- `pipeline-cli/src/dor/calibration-log.ts` (modified): `BODY_INLINE_LIMIT` 500 → 80; redaction applied to title, bodyPreview, verdict text fields, notes
- `pipeline-cli/src/dor/calibration-log.test.ts` (modified): roundtrip test reads persisted JSONL + asserts fake-token absence + redaction-marker presence
- `pipeline-cli/src/dor/index.ts` (modified): re-export `SECRET_PATTERNS` + `redactSecrets()` for downstream consumers
- `pipeline-cli/docs/dor.md` (new): "Calibration log secret hygiene" section documenting the 3-layer defense

## Design decisions
- **3 composed layers, not 1**: each layer covers a different failure mode of the others (gitignore bypassed if operator commits with -f; body-limit bypassed by short pastes; redactor bypassed by unrecognized formats). Defense-in-depth is the contract.
- **`appendCalibrationEntry()` returns the redacted entry**: even downstream `console.log` of the return value is safe.
- **Test fixtures use only fake tokens that pattern-match without being real** (`sk-testkeyABCDEF...`, `ghp_aaaa...`, `AKIAIOSFODNN7EXAMPLE` — the AWS docs example).

## Verification
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — all clean
- Coverage: secret-redact.ts 100%/100% line/branch; calibration-log.ts 98.76%/90.32% (both above 80% gate)
- 3 reviews APPROVED (`⚠ INDEPENDENCE NOT ENFORCED — codex unavailable`): code 0c/0M/2m/4s; test 0c/0M/1m/3s; security 0c/0M/4m/3s

## Follow-up
- **Pattern registry expansion (security minor)**: Anthropic `sk-ant-`, Slack `xox[bp]-`, Stripe `sk_live_`, GCP `AIza...`, SendGrid, Twilio, Mailgun — file as new task
- **Comment-loop ingress unredacted-verdict architectural follow-up (security minor)**: `redactVerdict()` docstring documents that the in-memory verdict is left unmutated for the comment-loop to post LLM-derived clarificationQuestion back to GitHub. If the LLM echoes a token from the body, it leaks back into the issue thread. Apply `redactSecrets()` upstream in evaluateIssueE2E or in the comment-loop ingress before posting — file as new task
- **Cosmetic minors (file as one combined task)**: AWS `{16}` → `{16,}` or `\b` anchor; GitHub PAT `{82}` → `{82,}`; HIGH-ENTROPY threshold raise (40 → 48 or 56) to reduce branch-name false positives; private-key BEGIN/END markers; JWT regex anchor-intent comment; `notes` field in dor.md target list
<!-- SECTION:FINAL_SUMMARY:END -->
