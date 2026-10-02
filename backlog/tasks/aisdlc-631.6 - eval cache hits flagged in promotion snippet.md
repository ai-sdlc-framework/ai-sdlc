---
id: AISDLC-631.6
title: >-
  RFC-0049 follow-up (security low): cli-judgment eval runs without cache reads by default and buildPromotion refuses MET when cache hits occurred
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0049
  - judgment-layer
  - security
  - cli
dependencies:
  - AISDLC-632
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/cli/judgment.ts
  - pipeline-cli/src/judgment/eval.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Security finding from AISDLC-631.3 (#1147), rated low, operator-approved for filing on
2026-10-02. `cli-judgment eval` forces shadow with the cache on, so a planted cache
entry (same-user write access) could inflate `actBandPrecision` and the MET promotion
snippet `buildPromotion` prints, which does not mention cache hits. Acceptable while a
human pastes the snippet; must land before AISDLC-641 and before any automated
consumer relies on eval output for promotion.

## Scope
1. `cli-judgment eval` defaults to no cache reads (`--use-cache` opts back in for
   threshold sweeps over already-recorded answers).
2. `buildPromotion` in `pipeline-cli/src/judgment/eval.ts` records `cacheHits` in the
   report and refuses to print MET when `cacheHits > 0`, printing instead the count and
   the instruction to re-run without the cache.
3. The promotion-record validation in the runtime rejects a record whose report shows
   `cacheHits > 0`.

## Acceptance Criteria
- [ ] `eval` without flags makes a provider call for every item even when a cache entry exists; `--use-cache` serves the entries.
- [ ] A report with `cacheHits > 0` prints not-met with the count, and a promotion record citing it is rejected by the runtime.
- [ ] A report with zero cache hits behaves exactly as before.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
