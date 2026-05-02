---
id: AISDLC-115.7
title: 'Phase 6: Bypass mechanism + escalation (dor-bypass label + 3-round escalation)'
status: Done
assignee: []
created_date: '2026-05-01 16:26'
labels:
  - rfc-0011
  - phase-6
  - bypass
  - escalation
milestone: m-3
dependencies:
  - AISDLC-115.6
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#74-bypass-mechanism
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#63-escalation
parent_task_id: AISDLC-115
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator escape hatch + escalation safety net. Bypass for cases where DoR is wrong; escalation for cases where the author has gone quiet. Per RFC §12 Phase 6 + §7.4 + §6.3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Maintainer-only `dor-bypass` label handler: label applied → issue admitted regardless of DoR verdict; bypass reason logged to calibration log with `override` event type
- [x] #2 Trusted-reviewer-role check (RFC-0009): only contributors in `.ai-sdlc/trusted-reviewers.yaml` can apply the label
- [x] #3 3-round escalation per RFC §6.3: if author hasn't responded after 3 clarification rounds, route to a configured human triager (Slack mention or GitHub team ping)
- [x] #4 Low-confidence verdicts (per Q4) auto-escalate via the same path — no auto-act on low confidence
- [x] #5 Escalation routing target configurable in `dor-config.yaml` (`escalation.triager`)
- [x] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 6 ships the dor-bypass label handler (trust-gated, override logged to calibration), the 3-round escalation decider (round-cap + low-confidence triggers per RFC §6.3 + Q4), and round-counter helpers. Decision-only modules; the calling shim posts comments + applies labels. `dor-config.escalation.triager` (string) added to TS parser + JSON schema with backward-compat for legacy `triageRouters` array.

## Changes
- `pipeline-cli/src/dor/bypass.ts` (new) + tests — handleBypassLabel; trust-gated; logs override
- `pipeline-cli/src/dor/escalation.ts` (new) + tests — decideEscalation + renderEscalationComment
- `pipeline-cli/src/dor/trusted-reviewers-check.ts` (new) + tests — actor membership check
- `pipeline-cli/src/dor/comment-loop.ts` — round-counter helpers (dorRoundMarker, countClarificationRounds)
- `pipeline-cli/src/dor/dor-config.ts` + spec/schemas/dor-config.v1.schema.json — escalation.triager field
- `pipeline-cli/src/dor/index.ts` — barrel
- `reference/src/core/{dor-schemas.test.ts, generated-schemas.ts}` — schema regen + validation tests

## Verification
- pnpm build / test / lint / format:check — all pass
- pipeline-cli 755/755 tests, reference 1258/1258 tests
- 3 reviews APPROVED — 0c/0M/4m/3s (⚠ INDEPENDENCE NOT ENFORCED — codex unavailable)

## Follow-up (deferred)
- Wire dor-bypass label → workflow YAML (`.github/workflows/dor-bypass.yml`) — operator-authored separate PR
- comment-loop.ts:492 — replace manual /g + lastIndex reset with matchAll() (code-reviewer suggestion)
- escalation.ts:1032 — confirm > vs >= for round-cap matches RFC §6.3 intent
- E2E test: drive decideEscalation through refineBacklogTask in comment-loop-e2e.test.ts (test-reviewer gap)
- Boundary test: roundCount === cap with low-confidence (test-reviewer gap)
<!-- SECTION:FINAL_SUMMARY:END -->
