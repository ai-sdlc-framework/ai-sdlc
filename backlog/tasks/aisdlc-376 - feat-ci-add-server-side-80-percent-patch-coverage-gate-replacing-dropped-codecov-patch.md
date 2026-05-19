---
id: AISDLC-376
title: 'feat(ci): add server-side 80% patch-coverage gate (replaces dropped codecov/patch as required)'
status: To Do
assignee: []
created_date: '2026-05-19'
labels:
  - ci
  - coverage
  - critical
dependencies: []
priority: critical
references:
  - .github/workflows/ci.yml
  - scripts/check-coverage.sh
  - docs/operations/quality-gate.md
---

## Problem

AISDLC-372 (merged in PR #560) dropped `codecov/patch` from required branch-protection contexts to remove the SaaS-latency bottleneck. The expectation per AISDLC-372 was that `scripts/check-coverage.sh` (the local pre-push hook) would remain the authoritative 80% gate.

**Gap**: the local gate is bypassable via `AI_SDLC_SKIP_COVERAGE_GATE=1`, AND has no CI-side mirror. PR #550 was pushed with the env var set (legitimately for the chore-sign commit), but subsequent code commits also escaped the 80% check. The PR landed in UNSTABLE state with 0.6% patch coverage — codecov/patch FAILED but is no longer required, so nothing blocked merge intent.

Operator (2026-05-19): "I thought that the local CI coverage would catch coverage below 80% but it didn't — we need that guard in place so issues don't merge with less than 80%"

## Fix (single PR)

### A. CI-side patch-coverage gate

Add a new step to `.github/workflows/ci.yml` Coverage job (or a new lightweight job):

```yaml
- name: Patch coverage gate (≥80%)
  if: github.event_name == 'pull_request'
  run: |
    # Run vitest --coverage on changed files only (same as today's PR coverage step)
    # Then assert patch line-coverage ≥ 80% across the changed files
    node scripts/check-pr-patch-coverage.mjs \
      --base "${{ github.event.pull_request.base.sha }}" \
      --head "${{ github.event.pull_request.head.sha }}" \
      --threshold 80
```

`scripts/check-pr-patch-coverage.mjs` (new helper) reads the LCOV from the vitest --changed run, extracts lines belonging to changed files in the PR diff, computes patch %, fails the step if < 80%.

### B. Add the gate to required branch protection

```bash
gh api -X PATCH repos/ai-sdlc-framework/ai-sdlc/branches/main/protection/required_status_checks \
  -F 'contexts[]=Backlog Drift' \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'contexts[]=ai-sdlc/attestation' \
  -F 'contexts[]=Patch coverage gate (≥80%)'
```

The rollup check `ai-sdlc/pr-ready` may already include Coverage but does NOT enforce a threshold — it's pass/fail based on the test step's exit code, not coverage delta.

### C. Document in quality-gate.md

Update `docs/operations/quality-gate.md` to name the new required check + reaffirm 80% as non-negotiable. Note the env-var bypass remains for chore commits but those don't trigger the CI gate (no code change → no diff → patch coverage N/A).

### D. Hermetic test for the helper

`scripts/check-pr-patch-coverage.test.mjs` validates:
- Returns success when patch % ≥ 80
- Returns failure when patch % < 80 with clear message naming the files
- Handles 0-changed-files (returns success, skip)
- Handles missing LCOV (returns failure with diagnostic)

## Acceptance criteria

- [ ] New helper `scripts/check-pr-patch-coverage.mjs` computes PR-diff patch coverage from LCOV and fails on < 80%
- [ ] Hermetic test `scripts/check-pr-patch-coverage.test.mjs` covers success/failure/edge cases
- [ ] CI workflow adds the gate step on `pull_request` events
- [ ] Branch protection includes the new required check
- [ ] `docs/operations/quality-gate.md` documents the new required check + reaffirms 80% threshold
- [ ] Tested by opening a PR with < 80% patch coverage and confirming it BLOCKS merge

## Out of scope

- Restoring codecov/patch as required (latency reason from AISDLC-372 still applies)
- Per-file coverage tuning (still 80% across the board)
- Whole-repo coverage gate (already covered by the Coverage job; this is patch-specific)

## Source

PR #550 (AISDLC-302) landed UNSTABLE with 0.6% patch coverage after shotgun-rename of 6 test files; operator 2026-05-19 flagged the missing CI-side gate. AISDLC-372 dropped codecov/patch from required without a replacement guard.
