---
id: AISDLC-412
title: 'fix(ci): attestation-gate workflow treats CANCELLED verify-attestation as FAILURE, blocking PRs unnecessarily'
status: To Do
labels: [ci, attestation, operator-merge, throughput]
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/verify-attestation.yml
  - scripts/check-pr-status-attestation.sh
priority: high
permittedExternalPaths: []
---

## Description

The `Attestation gate (code PRs)` rollup check reads the most recent `ai-sdlc/attestation` commit status. When two `verify-attestation` workflow runs race (the common case after a push that supersedes an in-flight push), the CANCELLED run posts `ai-sdlc/attestation: failure` as its terminal commit status. A later run posts `success` on the same commit SHA, but the rollup seems to read the FAILURE one — leaving PRs stuck even though the actual verifier succeeded on the current HEAD.

Symptom (observed today on several open PRs): `ai-sdlc/attestation: FAILURE` with one CANCELLED + one SUCCESS verify-attestation job listed in the status checks. The PR cannot merge until either (a) operator manually runs `gh run rerun <cancelled-id>` or (b) an empty commit re-triggers the workflow cleanly.

Today's workarounds (operator-time-expensive):
- `gh run rerun <cancelled-run-id>` per stuck PR
- Empty commit + push per stuck PR
- Wait for the next push event on the branch

## Acceptance criteria

- [ ] AC-1: Diagnose where the rollup reads the commit status from. Candidates: `.github/workflows/ai-sdlc-gate.yml` (re-actors/alls-green caller) and any `gh api .../commits/<sha>/statuses` consumer.
- [ ] AC-2: Determine whether GitHub commit-status API returns the LATEST status per context (it does — most recent wins) and whether the rollup is reading correctly. If so, the bug is on the workflow side: CANCELLED should not post FAILURE.
- [ ] AC-3: Fix `verify-attestation.yml` so the CANCELLED case posts no status (or posts the previous SUCCESS) rather than overwriting with FAILURE. Use a `if: cancelled()` step that exits cleanly without `gh api repos/.../statuses` POST.
- [ ] AC-4: Hermetic test: run two verify-attestation workflows concurrently, kill the older one mid-flight, confirm the newer one's SUCCESS status survives.
- [ ] AC-5: Document the workaround in `docs/operations/quality-gate.md` for operators encountering historical instances.

## Out of scope

- Re-running cancelled workflows on the currently-stuck PRs (operator can do this manually via `gh run rerun` while this fix is in flight).
- Rewriting the rollup pattern itself (it's the right shape — re-actors/alls-green).

## Estimated effort

1-2 hours.
