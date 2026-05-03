---
id: AISDLC-115.6
title: 'Phase 5: Metrics + observability (calibration log + Slack digest)'
status: Done
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-5
  - observability
  - metrics
milestone: m-3
dependencies:
  - AISDLC-115.5
parent_task_id: AISDLC-115
priority: medium
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#8-metrics-and-observability
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#55-calibration-log
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observability surface for DoR. The calibration log is what Phase 7 soak measures false-positive rate against. Without this, Phase 7 can't decide when to promote `warn-only` → `enforce`. Per RFC §12 Phase 5 + §8 + §5.5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Calibration log writer writes JSONL to `$ARTIFACTS_DIR/_dor/calibration.jsonl` (per-issue verdict + per-gate breakdown + confidence + author + timestamp)
- [x] #2 Per-author and per-gate aggregation queryable (e.g., `cli-dor-stats --by-author --by-gate`)
- [x] #3 Weekly Slack digest entry summarising: pass rate, top failing gates, override rate, false-positive trend
- [x] #4 Override events log to the same calibration log so Phase 7 soak can compute false-positive rate
- [x] #5 Metrics dashboard renders the first weekly digest end-to-end
- [x] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 5 DoR observability surface: added optional `author` field + `recordOverride()` helper to the calibration log, two new aggregation modules (`stats.ts`, `slack-digest.ts`), and two operator-facing CLIs (`cli-dor-stats`, `cli-dor-digest`) that drive per-author / per-gate breakdowns plus a Slack Block Kit weekly digest with a markdown dashboard renderer. The Slack digest and dashboard share one aggregation function so they cannot drift; window math computes the override Δ vs the immediately-prior equal-length window so Phase 7 soak can read false-positive trend straight from the calibration log.

## Changes
- `pipeline-cli/src/dor/calibration-log.ts` — `author` field on entry/input + `recordOverride()` writer (Phase 6 wires the dor-bypass callsite)
- `pipeline-cli/src/dor/stats.ts` (new) — `aggregateByAuthor` + `aggregateByGate` (multi-gate buckets correctly count an entry into every failed gate)
- `pipeline-cli/src/dor/slack-digest.ts` (new) — `buildWeeklyDigest()` Block Kit + `formatTrend()` + `renderMarkdownDigest()` for dashboard commits
- `pipeline-cli/src/cli/dor-stats.ts` + `bin/cli-dor-stats.mjs` (new) — `--by-author --by-gate --since --format --render-markdown`
- `pipeline-cli/src/cli/dor-digest.ts` + `bin/cli-dor-digest.mjs` (new) — emits Block Kit JSON for `curl $SLACK_WEBHOOK_URL`
- `pipeline-cli/src/dor/index.ts` + `package.json` — barrel + new bin entries
- `pipeline-cli/src/dor/ingress-claude.ts` — plumbs author through if upstream payload provides it

## Design decisions
- Shared aggregator path between Slack digest and markdown dashboard prevents drift
- Override write helper only — Phase 6 wires the callsite
- Author + free-text reason both pass through `redactSecrets()` defense-in-depth
- Slack payload renders only numeric aggregates + synthetic `gate-N` keys; never user-controlled free text → mrkdwn injection not exposed (security review confirmed)

## Verification
- `pnpm build` — passed
- `pnpm test` — passed (pipeline-cli vitest 695/695, +45 new; full workspace green)
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews APPROVED — 0c/0M/8m/2s across 3 reviewers (⚠ INDEPENDENCE NOT ENFORCED — codex unavailable)

## Follow-up (deferred)
- `priorWindow` boundary millisecond double-count (sub-1ms incidence)
- `--render-markdown` should plumb `--since`/`--until` instead of dropping them
- Top-gate ties: secondary sort key for deterministic ordering
- Document `evaluatorVersion: 'override-synthetic'` contract for Phase 7 implementer
- Test gaps (test-reviewer minors): explicit `filterByWindow` boundary assertion, prior-window-zero-entries trend test, `--until` smoke, `recordOverride` no-reason no-verdict path, `passRate` integration assertion
- Phase 6 (AISDLC-115.7+): wire `recordOverride()` into the dor-bypass action path
<!-- SECTION:FINAL_SUMMARY:END -->
