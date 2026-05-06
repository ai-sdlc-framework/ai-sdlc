---
id: AISDLC-208
title: >-
  verify-attestation-docs-only.yml skips on PRs that include attestation
  envelope files in their diff
status: Done
assignee: []
created_date: '2026-05-06 02:00'
updated_date: '2026-05-06 02:30'
labels:
  - bug
  - ci
  - attestation
  - aisdlc-205-followup
references:
  - .github/workflows/verify-attestation-docs-only.yml
  - .github/workflows/ai-sdlc-review-docs-only.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`verify-attestation-docs-only.yml`'s docs-only detection regex is `^(spec/rfcs/|docs/|backlog/tasks/|backlog/completed/|[^/]+\.md$)`. It does NOT include `.ai-sdlc/attestations/<sha>.dsse.json` paths. When a docs-only PR signs an envelope (e.g., to satisfy the merge_group verifier when verify-attestation.yml fires regardless of paths-ignore), the envelope file appears in the PR diff. The fallback workflow detects it as a "non-docs file" and skips posting `ai-sdlc/attestation: success` — exactly the deadlock the workflow was designed to prevent.

## Reproducer

PR #338 (chore: backlog sync, 16 docs file additions) — pushed an envelope chore commit `7ce233db` to satisfy the merge_group verifier (per AISDLC-205 round-3 design). The fallback workflow's detect step then read:

```
Non-docs file detected: .ai-sdlc/attestations/7ff1bff2d8ebdaf96760064d7deeecd7d8957d55.dsse.json
```

…and exited via the Skip branch. No `ai-sdlc/attestation: success` posted. Manual `gh run rerun` of `verify-attestation.yml` was needed to unblock — relying on the v4 envelope to validate cleanly.

## Fix

Add `\.ai-sdlc/attestations/[^/]+\.dsse\.json$` (anchored to root, single envelope file) to the docs-only regex. Envelope files are metadata about review, not "real code" — they should be treated as docs-equivalent for the fallback purpose.

Updated regex:
```
^(spec/rfcs/|docs/|backlog/tasks/|backlog/completed/|\.ai-sdlc/attestations/[^/]+\.dsse\.json$|[^/]+\.md$)
```

Apply the same fix to `ai-sdlc-review-docs-only.yml` if it has the same regex (likely does — they're sibling fallbacks).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `verify-attestation-docs-only.yml` regex includes `.ai-sdlc/attestations/<sha>.dsse.json` as a docs-only-equivalent path
- [x] #2 `ai-sdlc-review-docs-only.yml` regex updated to match (drift prevention — both sibling workflows must stay in sync)
- [ ] #3 Smoke test: open a docs-only PR that includes an envelope chore commit, verify the docs-only fallback workflow detects it as docs-only and posts the success status (does NOT skip via "Non-docs file detected") — DEFERRED to next docs-only PR that triggers an envelope chore commit (this PR itself isn't docs-only — touches .github/ — so its own CI fires verify-attestation.yml normally and doesn't exercise the new fallback path)
- [ ] #4 Composes with AISDLC-206 (shared classifier) — if the shared classifier ships first, the path list lives in one place and this fix is a one-line update there — TRACKED in AISDLC-206
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped in this PR. Updated docs-only detection regex in BOTH `verify-attestation-docs-only.yml` (line 114) and `ai-sdlc-review-docs-only.yml` (line 58) to add `\.ai-sdlc/attestations/[^/]+\.dsse\.json$` to the alternation. Envelope files are now treated as docs-equivalent — when a docs-only PR signs an envelope chore commit (per AISDLC-205 round-3 design), the fallback workflow detects the changeset as still docs-only and posts the success status instead of skipping via "Non-docs file detected".

Operationally observed on PR #338: 5-commit docs-only sync needed manual `gh run rerun` of `verify-attestation.yml` to unblock because the docs-only fallback skipped on the envelope file. After this fix, no manual intervention needed.

ACs #3 (smoke test) deferred to next docs-only PR that triggers an envelope chore commit — this PR itself touches .github/ so it is NOT docs-only and its CI fires verify-attestation.yml normally without exercising the new fallback regex branch. #4 (shared classifier composition) tracked separately by AISDLC-206.
<!-- SECTION:FINAL_SUMMARY:END -->
