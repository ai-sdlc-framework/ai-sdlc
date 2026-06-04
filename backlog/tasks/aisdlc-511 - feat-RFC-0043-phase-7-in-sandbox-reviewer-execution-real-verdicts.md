---
id: AISDLC-511
title: 'feat(reviewers): RFC-0043 Phase 7 — in-sandbox 3-reviewer execution + real verdicts'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - reviewers
dependencies:
  - AISDLC-509
  - AISDLC-510
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - pipeline-cli/src/pipeline/reviewer-matrix.ts
  - pipeline-cli/src/cli/ucvg.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The missing review brain (W3). Today `reviewer-matrix.ts` only *builds prompts* and *detects injection* (string heuristics) — no reviewer ever runs — and `buildUnsignedReport` hardcodes all three reviewers to `approved: false`, so the gate is permanently fail-closed. This task makes the reviewers actually run (in-sandbox, per AQ2) and populates real verdicts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 In-sandbox runner invokes the 3 reviewers (code/test/security) via `inference.local` (AISDLC-510) against the hardened-framed diff (`buildHardenedDiffSection`) + the differential test results (AISDLC-509)
- [ ] #2 Each reviewer verdict is parsed + schema-validated into `{ approved, findings, promptInjectionDetected }`; `detectInjectionAttempts` results are merged in (defense-in-depth)
- [ ] #3 `buildUnsignedReport` is populated with the REAL reviewer verdicts + computed consensus — the hardcoded `approved: false` placeholders are removed
- [ ] #4 Reviewers are constrained (no tool-use / no shell / no egress beyond inference.local) so a prompt injection can at most produce a bad verdict — which consensus + injection-detection + Stage-4 refusal already catch
- [ ] #5 A genuinely-good benign PR now yields `consensus.approved: true`; an injected/should-fail PR yields `approved: false` with the right findings
- [ ] #6 build/test/lint clean; ≥80% patch coverage; no shared `/tmp/.ai-sdlc` pollution in tests
<!-- AC:END -->

## Notes

Evaluate reuse of existing pipeline-cli model-invocation infra (invoker-loader / classifier substrate) for the reviewer calls rather than a bespoke client.
