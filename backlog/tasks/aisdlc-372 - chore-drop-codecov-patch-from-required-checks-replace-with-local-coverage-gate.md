---
id: AISDLC-372
title: 'chore(ci): drop codecov/patch from required branch protection; keep local 80% coverage gate as authoritative'
status: To Do
assignee: []
created_date: '2026-05-19'
labels:
  - ci
  - throughput
  - critical
dependencies: []
priority: critical
references:
  - .github/workflows/ci.yml
  - scripts/check-coverage.sh
  - docs/operations/quality-gate.md
---

## Problem

`codecov/patch` is the single longest-blocking required status on every PR. It blocks merges for two reasons:

1. **Codecov SaaS processing latency**: codecov.io often takes 5-15min AFTER our upload to compute + post the status. This is third-party infrastructure with shared backpressure; we have no control over the delay.
2. **App-source requirement**: branch protection requires the status to come from the codecov GitHub App specifically. Any PR where vitest produces 0 coverage data (PRs touching only `.github/workflows/`, `scripts/`, docs, etc.) leaves codecov with nothing to upload → codecov never posts → PR sits BLOCKED forever even when all our own checks pass. We hit this on PRs #553 and #554 in the AISDLC-370 development cycle and had to ship a workaround (empty-LCOV fallback).

Combined effect: codecov/patch routinely adds 5-15min to every PR's wall-clock time, and occasionally deadlocks PRs entirely.

Meanwhile we already have a **stronger, faster, authoritative coverage gate locally**: `scripts/check-coverage.sh` (the pre-push hook) enforces 80% lines coverage per package. It runs in <1min and blocks the push if coverage drops. The codecov/patch status is redundant — it measures the same property using a slower, less-reliable mechanism.

## Fix (single PR)

### A. Remove `codecov/patch` from required status checks

```bash
gh api -X PATCH repos/ai-sdlc-framework/ai-sdlc/branches/main/protection/required_status_checks \
  -F 'contexts[]=Backlog Drift' \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'contexts[]=ai-sdlc/attestation'
```

(Drops `codecov/patch`. Keeps the other 3 required checks.)

This is an operator-level branch-protection change. The implementation PR includes:

- The exact `gh api` command above committed as `scripts/apply-codecov-drop.sh` so it's reproducible
- A `docs/operations/quality-gate.md` update naming the new required-check list + the rationale

### B. Keep codecov running as INFORMATIONAL

`codecov/codecov-action@v5` upload stays in `ci.yml` so the codecov PR comment + the codecov.io dashboard still work. Operators can still see coverage trends + line-by-line annotations. Just no longer blocks the merge.

### C. Document the local pre-push gate as authoritative

Update `docs/operations/quality-gate.md`:

- Add a "Why codecov/patch is informational, not required" section
- Reaffirm `scripts/check-coverage.sh` as the authoritative 80% gate
- Note that operators can still drop below 80% via `AI_SDLC_SKIP_COVERAGE_GATE=1` for emergencies (existing pattern)

### D. Remove the empty-LCOV fallback after this lands

The empty-LCOV workaround added in AISDLC-370 (PR #554) only exists to satisfy codecov/patch when no tests run. Once `codecov/patch` is no longer required, the fallback becomes dead code. Remove it in this PR — keep CI simple.

## Acceptance criteria

- [ ] `gh api PATCH .../branches/main/protection/required_status_checks` executed; `codecov/patch` no longer in `contexts[]`
- [ ] Reproducible script at `scripts/apply-codecov-drop.sh` committed (operator can rerun if branch protection is recreated)
- [ ] `docs/operations/quality-gate.md` updated with new required-check list + rationale
- [ ] Empty-LCOV fallback in `.github/workflows/ci.yml` Coverage steps removed (AISDLC-370 dead code)
- [ ] Verified by opening a test PR touching only `.github/workflows/` (no test changes) and confirming it lands without operator manual unblocking

## Out of scope

- Replacing codecov.io with a different coverage service (separate evaluation work)
- Self-hosted coverage server (much bigger scope)
- Per-package coverage threshold tuning (still 80% across the board)

## Source

Operator question 2026-05-19: "the required codecov/patch this is what I find is the longest task to finish. We are often waiting for it to finish before the PR can be merged. How is this one different from the CI/Coverage test we run?" — answered: codecov/patch is the bot's post-back to our upload; happens on their infrastructure; we have a faster local gate that's authoritative. Drop the required-status dependency, keep codecov for reporting.
