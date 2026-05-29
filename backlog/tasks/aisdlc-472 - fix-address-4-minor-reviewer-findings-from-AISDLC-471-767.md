---
id: AISDLC-472
title: 'fix: address 4 minor reviewer findings from AISDLC-471 (#767)'
status: To Do
assignee: []
created_date: '2026-05-28 23:48'
labels:
  - follow-up
  - minor
  - documentation
  - attestation
dependencies:
  - AISDLC-471
references:
  - 'https://github.com/ai-sdlc-framework/ai-sdlc/pull/767'
  - scripts/check-attestation-sign.sh
  - scripts/check-attestation-sign.test.mjs
  - docs/operations/attestation-troubleshooting.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to AISDLC-471 / PR #767. The 3 reviewer agents APPROVED with 4 minor findings total. None blocked the merge; this task captures them for cleanup.

**Findings:**

1. **(code-reviewer)** `scripts/check-attestation-sign.sh:363` + `:376` — comment claims `git add` of an empty/absent directory is a no-op, but under `set -euo pipefail` `git add` on a non-existent path exits 128 (fatal). The `[ -d ]` guard on line 379 is therefore necessary, NOT merely defensive. Code is correct; comment is misleading. Fix: rewrite both comments to accurately explain the guard's purpose.

2. **(code-reviewer)** `scripts/check-attestation-sign.test.mjs:115` — fake signer's `writeBlock` loop initializes `prev_was_schema_version=0` (variable never read) instead of resetting `prev_was_schema=0` (the variable actually checked). Dead-code state machine; grep-based fallback on line 120 saves correctness. Fix: rename to `prev_was_schema` for clarity OR delete the dead variable.

3. **(code-reviewer)** `docs/operations/attestation-troubleshooting.md:17` — example strings `'leaves source: shared (legacy fallback)'` and `'leaves source: per-patch-id'` don't match the verifier's actual verbose output `'leaves source: shared (.ai-sdlc/transcript-leaves.jsonl) [AISDLC-421 legacy fallback, filtered by taskId=...]'`. Operators following the runbook with substring grep will get no match. Fix: replace with the actual pattern, e.g. `grep 'leaves source:' in the CI log`.

4. **(test-reviewer)** `scripts/check-attestation-sign.test.mjs:678` — the `withLeaves: true` path is only tested through `AI_SDLC_INTERNAL_NO_EXIT_1=1` (orchestrator mode). The standalone exit-1 path (normal pre-push invocation) with a leaves file present is not separately covered. The commit-staging logic is identical in both modes (very low risk), but a dedicated test would complete the combinatorial coverage.

**Source:** reviewer transcripts at `.ai-sdlc/transcripts/AISDLC-471/{code,test,security}-reviewer.jsonl` from the 2026-05-28 reconcile of PR #767.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Rewrite comments at `scripts/check-attestation-sign.sh:363` and `:376` to accurately explain why the `[ -d ]` guard is mandatory (git add on absent path exits 128 under set -euo pipefail, NOT a no-op)
- [ ] #2 Fix or delete the dead-code `prev_was_schema_version` variable in `scripts/check-attestation-sign.test.mjs:115`; rename to `prev_was_schema` or remove entirely
- [ ] #3 Update `docs/operations/attestation-troubleshooting.md:17` example strings to match the verifier's actual verbose output (replace abbreviated examples with the actual prefix operators should grep for)
- [ ] #4 Add a dedicated test for the `withLeaves: true` standalone exit-1 path in `scripts/check-attestation-sign.test.mjs` (normal pre-push invocation with leaves file present, NOT under AI_SDLC_INTERNAL_NO_EXIT_1=1)
<!-- AC:END -->
