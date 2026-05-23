---
id: AISDLC-412
title: 'fix(ci): attestation-gate workflow treats CANCELLED verify-attestation as FAILURE, blocking PRs unnecessarily'
status: Done
labels: [ci, attestation, operator-merge, throughput]
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/verify-attestation.yml
  - .github/workflows/__tests__/verify-attestation-cancelled.test.mjs
  - docs/operations/quality-gate.md
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

- [x] AC-1: Diagnose where the rollup reads the commit status from. Candidates: `.github/workflows/ai-sdlc-gate.yml` (re-actors/alls-green caller) and any `gh api .../commits/<sha>/statuses` consumer.
- [x] AC-2: Determine whether GitHub commit-status API returns the LATEST status per context (it does — most recent wins) and whether the rollup is reading correctly. If so, the bug is on the workflow side: CANCELLED should not post FAILURE.
- [x] AC-3: Fix `verify-attestation.yml` so the CANCELLED case posts no status (or posts the previous SUCCESS) rather than overwriting with FAILURE. Use a `if: cancelled()` step that exits cleanly without `gh api repos/.../statuses` POST.
- [x] AC-4: Hermetic test: run two verify-attestation workflows concurrently, kill the older one mid-flight, confirm the newer one's SUCCESS status survives.
- [x] AC-5: Document the workaround in `docs/operations/quality-gate.md` for operators encountering historical instances.

## Out of scope

- Re-running cancelled workflows on the currently-stuck PRs (operator can do this manually via `gh run rerun` while this fix is in flight).
- Rewriting the rollup pattern itself (it's the right shape — re-actors/alls-green).

## Estimated effort

1-2 hours.

## Final summary

### Diagnosis (AC-1, AC-2)

- The rollup `Attestation gate (code PRs)` in `.github/workflows/ai-sdlc-gate.yml` reads `ai-sdlc/attestation` via `gh api .../commits/<sha>/statuses`, which returns the most-recent status POST per context (GitHub keeps a status history per context but the rollup APIs surface the latest).
- The bug was workflow-side: when two `verify-attestation` runs race (`concurrency.cancel-in-progress: true`), the CANCELLED run's `Post ai-sdlc/attestation status` step still fired because the original `if: always()` is the UNION of `success()`, `failure()`, AND `cancelled()`. The cancelled run had no STATUS output from the (cancelled-mid-flight) `Verify attestation` step, so it posted `failure` with description "verifier crashed before emitting result".
- When that POST happened to land AFTER the new run's SUCCESS POST (race-order dependent), the PR sat stuck on a stale FAILURE.

### Fix (AC-3)

`.github/workflows/verify-attestation.yml`: changed the `Post ai-sdlc/attestation status` step's `if:` expression from `always() && …` to `(success() || failure()) && …`. This is the canonical "run on crash, NOT on cancel" pattern — `success() || failure()` is `always() && !cancelled()`. The verifier-crash recovery branch (uncaught exception → `failure()` true → step posts STATE=failure with a clear "crashed" reason) is preserved exactly.

The task's suggested form (`if: cancelled()` early-exit step) would have worked too, but the inverse condition is one swap of a single function reference (less surface area for future regressions vs adding a new no-op step that has to be re-evaluated whenever the post-status logic moves).

### Hermetic test (AC-4)

`.github/workflows/__tests__/verify-attestation-cancelled.test.mjs` (5 tests, all passing locally):

- Asserts `concurrency.cancel-in-progress: true` is still declared (the precondition that creates the race; if dropped, this test's premise becomes moot — failing-loud here is intentional).
- Asserts the `Post ai-sdlc/attestation status` step does NOT use `always()`.
- Asserts the step uses `(success() || failure())` (both halves present — `success()` for happy-path, `failure()` for crash recovery; neither alone is sufficient).
- Asserts the step does NOT reference `cancelled()` (defense-in-depth against `if: !cancelled()` regressions).
- Asserts the short-circuit guards (`docs_only`, `release_please`) are still present.
- Asserts inline comments reference AISDLC-412 + the cancellation rationale.

The task spec's literal AC-4 ("run two verify-attestation workflows concurrently, kill the older one mid-flight") cannot be exercised hermetically — that would need a live GitHub Actions runner pair. The static YAML assertions above are the highest-confidence hermetic substitute; they catch every recurrence of the exact regression class.

### Operator docs (AC-5)

`docs/operations/quality-gate.md`: added a "Historical workaround — `ai-sdlc/attestation: FAILURE` after a cancelled verify-attestation run (AISDLC-412)" section documenting the symptom, root cause, the three operator workarounds (`gh run rerun`, empty commit push, wait for next push), and a table comparing the GitHub status-check function semantics so future editors understand why `(success() || failure())` is the canonical pattern.

### Verification

- `node --test .github/workflows/__tests__/verify-attestation-cancelled.test.mjs` — 5 tests pass.
- `node --test .github/workflows/__tests__/fork-pr-safety.test.mjs` — 49 tests pass (regression guard for the broader workflow surface).
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean.
