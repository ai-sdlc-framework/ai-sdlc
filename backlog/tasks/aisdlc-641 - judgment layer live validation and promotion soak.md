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
  - AISDLC-630.3
  - AISDLC-630.4
  - AISDLC-632
  - AISDLC-633
  - AISDLC-634
  - AISDLC-635
  - AISDLC-636
  - AISDLC-637
  - AISDLC-638
  - AISDLC-639
  - AISDLC-643
  - AISDLC-644
  - AISDLC-647
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - docs/operations/dor-promotion.md
priority: medium
dispatchable: false
dispatchableReason: "Operator-only: needs the live API key (provisioned locally 2026-11-07), operator judgment on thresholds, and a soak window; no code work to dispatch"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-run. The first point in the series that needs a live typesafe.ai API key.
Everything before it is verified against recorded fixtures built from the provider's
documentation, so the first job here is to find out where the documentation and the
live API differ.

Status 2026-11-07: the operator provisioned the typesafe.ai key on 2026-11-07 in the
local root `.env` as `TYPESAFE_AI_API_KEY`. The code reads `TYPESAFE_API_KEY`, so export
the value under that name when running step 1 (the key value is never written anywhere
in the repository). The code prerequisites AISDLC-630.3, AISDLC-630.4 and AISDLC-644 are
now dispatched (operator ruling 2026-11-07); this task starts once they land.

## Ruling 2026-11-07 (operator, decision rubric)

Option A, go live. The judgment layer shipped in October but AISDLC-641 never ran for want of a live key; the operator provisioned the key on 2026-11-07. The three code blockers (redaction hardening 630.3/630.4, capability-liveness doctor 644) have value without Jev and were parked only by the 2026-10-06 batch. Counter-argument considered: merging them without validation risks dead code; rejected because redaction already runs in the reference package today. 633.2 and 636.1 ride along; 635.1 still waits on 641's shadow data.

## Status 2026-11-08 (steps 1, 2 and the first of step 3 done; operator order "turn it on")

- Step 1: the live contract test passed against the real API (no fixture drift);
  `cli-judgment doctor --live` returned modelVersion `jev-1.13.0`, latency 109 ms.
- Step 2: `.ai-sdlc/judgment-config.yaml` committed with provider `jev`, model `jev-1.13.0`,
  every judgment in `shadow`, egress `work-item-text`, `code-diff`, `agent-output`.
- Step 3, `dor.stage-b` on the 78-fixture DoR corpus (report under `.ai-sdlc/judgment-evals/`):
  act-band precision peaks at 16.7% (fail threshold 0.06, 12 flags, 2 true) and falls to
  8.0% at 0.2; the `pass` threshold does not move the bands. Far below the 90% tighten bar,
  so it stays in `shadow`. No corpus exists yet for the five substrate judgments
  (`.ai-sdlc/classifier-corpus/` is absent), `estimate.class` or `decision.recommendation`:
  those are explicit no-data entries until the shadow log fills.
- Step 4, measured against RFC-0049 section "Why Jev": latency p50 67 to 76 ms, p95 161 to
  180 ms (RFC quotes about 100 ms); cost $0.002874 for 68,422 input tokens, which is the
  quoted $0.042 per million exactly.
- Open: steps 5 to 8 (shadow soak, promotion by PR, doctor `live` rows, results note).

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
7. As each capability is proven, confirm `/ai-sdlc doctor` shows it `live` in the
   `capability-liveness` table, then change its `runtimeEvidence` entry to `live` in
   the RFC that specifies it, citing the judgment-log or state-file record.
8. Write a short results note answering the RFC's four value hypotheses with measured
   numbers: tasks stopped before a developer run, developer returns flagged before
   reviewer fan-out, findings flagged as ungrounded, and operator queue items resolved
   without a manual step.

## Acceptance Criteria
- [ ] The live contract test passes, or each mismatch is filed and fixed before evaluation starts.
- [ ] `.ai-sdlc/judgment-config.yaml` is on `main` with an exact model version and every judgment in `shadow`.
- [ ] An evaluation report exists under `.ai-sdlc/judgment-evals/` for each judgment that has a corpus.
- [ ] Measured p50 and p95 latency and cost per evaluation are recorded against the documented figures.
- [ ] Every judgment moved to `enforce` has a promotion record meeting its `riskClass` bar, and `review.reviewer-set` is not promoted on fewer than 50 ledger rows or below 0.95 act-band precision.
- [ ] Each promoted capability shows `live` in the doctor table and its `runtimeEvidence` entry cites the record that proves it; capabilities still degraded keep a `degraded` entry with an owner or an explicit no-owner statement.
- [ ] A results note records a measured answer, or an explicit no-data statement, for each of the four value hypotheses.
<!-- SECTION:DESCRIPTION:END -->
