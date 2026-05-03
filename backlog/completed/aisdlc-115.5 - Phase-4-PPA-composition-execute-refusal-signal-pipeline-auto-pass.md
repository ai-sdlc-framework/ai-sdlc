---
id: AISDLC-115.5
title: 'Phase 4: PPA composition + execute refusal + signal-pipeline auto-pass'
status: Done
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-4
  - ppa-integration
  - auto-pass
milestone: m-3
dependencies:
  - AISDLC-115.4
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
parent_task_id: AISDLC-115
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#7-pipeline-integration
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      backlog/docs/ppa-product-signoff-rfc0011.md
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wires DoR verdicts into the existing pipeline boundaries: PPA admission + `/ai-sdlc execute` start gate. Folds in Alex's Addition 1 (signal-pipeline auto-pass) per Product sign-off. Per RFC §12 Phase 4.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 PPA admission step amended to skip issues in `Needs Clarification` (no scoring effort wasted on unready issues)
- [x] #2 `/ai-sdlc execute <task-id>` refuses to start when task is in `Needs Clarification`, with a clear error message + link to the DoR comment
- [x] #3 Signal-pipeline auto-pass per Alex's Addition 1: new `kind: signal-pipeline-generated` rule in `dor-config.yaml` autoPassRules; gates 1, 4, 5, 6 skipped; gates 2, 3, 7 retained
- [x] #4 `evaluateIssue()` interface accepts a `gatesSkipped` parameter (or equivalent shape per Alex's note to Dom)
- [x] #5 Existing tests pass; new tests cover the refusal paths + the signal-pipeline auto-pass path
- [x] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 4 wires DoR verdicts into existing pipeline boundaries:
- **PPA admission** (`mapIssueToPriorityInput`): Needs Clarification short-circuit added alongside existing Draft veto
- **`/ai-sdlc execute` Step 1** (`validateTask`): refuses execution when status is Needs Clarification, points at `<!-- ai-sdlc:dor-comment -->` marker
- **Signal-pipeline auto-pass** (Alex's Addition 1): new `kind: signal-pipeline-generated` rule in `dor-config.yaml` autoPassRules; gates 1, 4, 5, 6 skipped; gates 2, 3, 7 retained
- **gatesSkipped parameter**: added to `EvaluateOpts`/`EvaluateE2EOpts`; auto-passed gates appear in verdict as `verdict:'skip', confidence:'high', stage:'A', finding:'auto-pass: <kind>'`. `pickStageBGates()` filters auto-passed gates so Stage B doesn't re-evaluate.

## Verification
- pnpm build && pnpm test && pnpm lint && pnpm format:check — clean
- 35 new tests across 5 files; all 664 pipeline-cli + 2,933 orchestrator tests pass
- Coverage: auto-pass.ts 100%, evaluate.ts 100%, dor-config.ts 100%, ingress-claude.ts 98.16%, 01-validate.ts 95.62%, admission-score.ts near-100%
- 3 reviews APPROVED: code 0c/0M/2m/2s; test 0c/0M/1m/3s; security 0c/0M/1m/1s
- Stage A regression suite (corpus.test.ts, RFC §5.6 tier 1) UNCHANGED

## Follow-up
- **`/ai-sdlc dor-recheck` slash command** (code minor): execute.md Step 1 refusal text references it but not yet shipped — RFC §7.3 forward reference. Wording could be tightened OR the command shipped (small task).
- **`pickStageBGates()` auto-pass exclusion direct unit test** (code+test minor, duplicate): currently covered transitively via refineBacklogTask integration tests; focused unit test would lock the contract.
- **GitHub-issue ingress authorIdentity contract** (security minor): when GitHub-issue ingress lands, untrusted GitHub user.login MUST NOT flow into autoPassRules sources matching without an allowlist. Documented for the GitHub ingress wiring task.
- **Aggregate confidence on full-skip** (code suggestion): when all 7 gates auto-pass, `aggregateConfidence()` returns 'low' (no contributing gates). Counter-intuitive shape; consider 'high' for explicit auto-pass.
- **YAML int parser silence** (code suggestion): `parseIntStrict` returns 0 on NaN; malformed `gatesSkipped: [foo, 3]` becomes [0, 3] then filtered. Low priority since CI schema validation catches.
- AISDLC-115.6 (Phase 5 metrics + observability) is now unblocked.
<!-- SECTION:FINAL_SUMMARY:END -->
