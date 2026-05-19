---
id: AISDLC-375
title: 'test(pipeline-cli): bisect which quality-* test file causes Coverage hang from AISDLC-302'
status: To Do
assignee: []
created_date: '2026-05-19'
labels:
  - test
  - flaky
  - tech-debt
dependencies: []
priority: medium
references:
  - pipeline-cli/src/tui/analytics/quality-classifier.test.ts
  - pipeline-cli/src/tui/analytics/quality-metrics.test.ts
  - pipeline-cli/src/tui/analytics/quality-router.test.ts
  - pipeline-cli/src/tui/analytics/quality-reader.test.ts
  - pipeline-cli/src/tui/analytics/determinism-detector.test.ts
  - pipeline-cli/src/cli/quality-corpus.test.ts
---

## Problem

AISDLC-371 AC #6 called for bisecting the Coverage hang caused by AISDLC-302's new test files. PR #550 (AISDLC-302) hit the hang repeatedly: Coverage + Build & Test (Node 20/22) jobs stayed IN_PROGRESS for 18+ min and never completed.

To unblock 550, all 6 suspect test files were shotgun-renamed to `*.flaky.test.ts` (excluded from default vitest run per AISDLC-371's convention). This let 550 land but the actual culprit is unidentified — only one of the 6 is causing the hang.

## Files renamed (all should be bisected)

- `pipeline-cli/src/cli/quality-corpus.flaky.test.ts`
- `pipeline-cli/src/tui/analytics/determinism-detector.flaky.test.ts`
- `pipeline-cli/src/tui/analytics/quality-classifier.flaky.test.ts`
- `pipeline-cli/src/tui/analytics/quality-metrics.flaky.test.ts`
- `pipeline-cli/src/tui/analytics/quality-reader.flaky.test.ts`
- `pipeline-cli/src/tui/analytics/quality-router.flaky.test.ts`

## Bisect approach

1. Re-enable one file at a time by renaming back to `*.test.ts` in a small PR
2. Push and watch Coverage job: if completes <2 min the file is fine; if hangs >10 min that's the culprit
3. Once identified, root-cause: likely candidates per AISDLC-371 hypothesis:
   - JSONL writer / reader test holding a file handle open
   - Sampling-logic test with an infinite-loop edge case
   - Async timer/interval not unmounted in unmount-cleanup test
4. Fix the underlying determinism + restore the file as a non-flaky test

## Acceptance criteria

- [ ] Bisect identifies the offending test file (one or more) from the 6 candidates
- [ ] Root cause documented (hang source: open handle / infinite loop / unmounted async / etc.)
- [ ] Offending test fixed and restored as a deterministic non-flaky test
- [ ] Non-offending files restored to `*.test.ts` once cleared
- [ ] Nightly flaky workflow (AISDLC-371) successfully exercises any tests that remain flaky

## Out of scope

- Replacing the AISDLC-302 quality-monitoring feature itself (it's correct; only the tests hang)
- Broader vitest-coverage tuning beyond these 6 files

## Source

PR #550 (AISDLC-302) Coverage hang 2026-05-19; operator authorized shotgun-rename for ship; this task tracks the proper bisect follow-up.
