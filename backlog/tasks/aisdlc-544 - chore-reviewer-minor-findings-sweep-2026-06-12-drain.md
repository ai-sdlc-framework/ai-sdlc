---
id: AISDLC-544
title: >-
  chore: reviewer minor-findings sweep from the 2026-06-12 drain — boundary
  semantics, regression-test gaps, and hygiene nits across AISDLC-468/535/536
status: To Do
assignee: []
labels:
  - tests
  - hardening
  - review-followup
  - ci:no-issue-required
priority: low
dependencies: []
references:
  - orchestrator/src/journey/metric-snapshot.ts
  - orchestrator/src/shared.ts
  - pipeline-cli/src/steps/11-late-rebase.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Consolidated minor/suggestion findings from the reviewer fan-outs of the
2026-06-12 autonomous drain. All were approved-with-notes (none blocking);
this sweep closes them in one mechanical pass. Each item names its file and
the originating reviewer rationale.

**From AISDLC-468 (PR #910, MetricSnapshot):**
1. `orchestrator/src/journey/metric-snapshot.ts` ~line 395 — hard-block policy
   grants one implicit grace day: the `daysOverdue <= 0` early-exit means
   hard-block fires at day 1, while the design language says "cadence+0d (no
   grace)". Decide the intended boundary (operator judgment, one line either
   way), implement, and align the boundary test.
2. Same file ~line 233 — future-dated `spec.recordedAt` yields negative age →
   metric perpetually fresh and the stale Decision is suppressed. Reject
   `recordedAt > now` at validation or clamp negative age to stale.
3. Same file ~line 453 — guard `Number.isFinite(daysOverdue)` in the graduated
   path so NaN cannot fall through to warn/1.0 (fail-open).
4. Decision-routing delegation: `journey-metric-stale` decisions rely on
   callers reading `result.decision`; document the contract in the module
   JSDoc (or add a typed must-consume wrapper) so callers cannot silently
   drop it.
5. Add AJV schema round-trip tests for `metric-snapshot.v1.schema.json`
   (accept well-formed; reject missing-required / wrong apiVersion const /
   metricId pattern violation / unknown property).

**From AISDLC-535 (PR #913, CodeQL fixes):**
6. `orchestrator/src/shared.test.ts` — assert `validateBranchName('')` throws.
7. `orchestrator/src/cycle-utils.test.ts` — add the motivating interleaved
   input `<scr<script>ipt>` so a regression to single-pass stripping fails.
8. `pipeline-cli/src/steps/11-late-rebase.test.ts` — add a multi-conflict-block
   fixture exercising the while-loop path; also switch the separator match
   from `startsWith('=======')` to exact `line === '======='` per the code
   review note.
9. Backslash-before-quote ordering tests: pass a literal-backslash value
   through `escapeYamlDoubleQuoted` (init-compliance-wizard), `escapeDotLabel`
   (dependency-graph), and `matchesGlob` (file-walker) so the ordering fix is
   not silently revertible. Also wrap `attestedAt` in `escapeYamlDoubleQuoted`
   in init-features.ts ~line 366 for uniformity.
10. `orchestrator/src/shared.ts` JSDoc — note `{issueTitle}` is unsafe in
    custom branch patterns; recommend `{slug}`.

**From AISDLC-536 (PR #914, workflow hardening):**
11. `.github/workflows/ai-sdlc.yml` triage-gate job — drop the unused
    `pull-requests: read` grant.

**Carried observation (not new code):** the cli-capture graceful-fallback
timeout flake recurred once in CI on PR #910's Coverage job after the
AISDLC-533 de-flake landed (rerun passed). If it recurs again, reopen as its
own investigation rather than extending this sweep.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Items 1-5 landed: boundary decision implemented + tested, recordedAt/NaN guards in place, decision-routing contract documented, schema round-trip tests added
- [ ] #2 Items 6-10 landed: the four test gaps closed, separator exact-match change made, attestedAt escaped, JSDoc advisory added
- [ ] #3 Item 11 landed: unused permission grant removed with workflow tests green
- [ ] #4 Full verification passes: `pnpm build`, affected package tests, `pnpm lint`, workflow test suites
<!-- AC:END -->
