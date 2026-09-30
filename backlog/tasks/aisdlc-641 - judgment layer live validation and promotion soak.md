---
id: AISDLC-641
title: >-
  RFC-0049 live validation: contract test, first evaluations, threshold setting and per-judgment promotion (operator)
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-9
  - operator
  - soak
dependencies:
  - AISDLC-632
  - AISDLC-633
  - AISDLC-634
  - AISDLC-635
  - AISDLC-636
  - AISDLC-637
  - AISDLC-638
  - AISDLC-639
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - docs/operations/dor-promotion.md
priority: medium
dispatchable: false
dispatchableReason: "Operator-only: needs the live API key, operator judgment on thresholds, and a soak window; no code work to dispatch"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-run. The first point in the series that needs a live typesafe.ai API key.
Everything before it is verified against recorded fixtures built from the provider's
documentation, so the first job here is to find out where the documentation and the
live API differ.

## Scope
1. Export `TYPESAFE_API_KEY` locally. Run the live contract test
   (`AI_SDLC_LIVE_CONTRACT=1`) and `node pipeline-cli/bin/cli-judgment.mjs doctor --live`.
   Record the returned model version and latency. Any shape mismatch with the fixtures
   is filed as a bug against the Jev adapter before going further.
2. Commit `.ai-sdlc/judgment-config.yaml` with provider `jev`, the exact model version
   reported by the live call, every judgment in `shadow`, and `egress.allow` listing
   `work-item-text`, `code-diff` and `agent-output` for this repository.
3. Run `cli-judgment eval` with `--sweep` for each judgment that has a corpus today:
   `dor.stage-b` against the DoR corpus, the five substrate judgments against the
   classifier corpus, `estimate.class` against the estimates log, and
   `decision.recommendation` against decision events with overrides. Save each report
   under `.ai-sdlc/judgment-evals/`.
4. From the reports, set thresholds per judgment. Record measured latency and cost per
   evaluation next to the figures the RFC quotes from the provider's documentation,
   and note every place they differ.
5. Let `shadow` run during normal pipeline use until `review.reviewer-set` has at least
   50 findings-ledger rows, then evaluate it.
6. Promote judgments one at a time by PR, each citing its report and carrying its
   promotion record, following the bars in RFC-0049 section 8.
7. Write a short results note answering the RFC's four value hypotheses with measured
   numbers: tasks stopped before a developer run, developer returns flagged before
   reviewer fan-out, findings flagged as ungrounded, and operator queue items resolved
   without a manual step.

## Acceptance Criteria
- [ ] The live contract test passes, or each mismatch is filed and fixed before evaluation starts.
- [ ] `.ai-sdlc/judgment-config.yaml` is on `main` with an exact model version and every judgment in `shadow`.
- [ ] An evaluation report exists under `.ai-sdlc/judgment-evals/` for each judgment that has a corpus.
- [ ] Measured p50 and p95 latency and cost per evaluation are recorded against the documented figures.
- [ ] Every judgment moved to `enforce` has a promotion record meeting its `riskClass` bar, and `review.reviewer-set` is not promoted on fewer than 50 ledger rows or below 0.95 act-band precision.
- [ ] A results note records a measured answer, or an explicit no-data statement, for each of the four value hypotheses.
<!-- SECTION:DESCRIPTION:END -->
