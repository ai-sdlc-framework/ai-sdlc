---
id: AISDLC-885
title: 'feat(cost): per-PR, per-rung model spend report (developer round included) in the cost tracker and the operator digest; no cap in v1'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, phase-1, cost, kpi]
dependencies: [AISDLC-884]
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - orchestrator/src/cost-tracker.ts
  - pipeline-cli/bin/cli-decisions.mjs
  - docs/operations/agent-governance-reference.md
priority: medium
dispatchable: true
---

## Context

RFC-0054 OQ-14 (resolved 2026-10-14): no development trio in this RFC, but per-PR developer-round spend is measured from Phase 1 so a trio decision can be made from data; the budget is report-only in v1, with the Phase 3 target being a per-PR token budget where rung-4 spend requires a logged rung-3 failure. This task builds the report and shapes it to produce exactly the numbers that Phase 3 rule needs (rung-3 outcomes logged per typed question). Operator priority: token cost is second only to velocity.

## Fix

**Five-step review (requirements first).** Requirement questioned: "set a spend cap now". No: a cap without a baseline either blocks the first legitimate long fix or is decorative; measure first. Deleted: nothing. Simplified: one event shape for every model call, tagged with the rung declared in the caller's frontmatter (AISDLC-884). Accelerated: the operator sees spend per PR in the digest they already read. Automated last: the Phase 3 budget rule, once the distribution is known.

1. Cost event: every model call made by the pipeline (developer round, reviewer rounds, judgment-layer questions, staged review, any Agent spawn through the plugin) emits `{prNumber|taskId, rung, agent, model, inputTokens, outputTokens, calls, state (PR state at the time), outcome (for rung 2 and 3: answered|below-floor|escalated)}` to the existing cost tracker ledger.
2. `cli-kpi spend --pr <n>|--since <date> [--json]`: per PR, spend by rung and by agent; across PRs, the distribution (median, p90, max) of total and rung-4 spend, developer-round spend shown as its own line.
3. Operator digest (`cli-decisions operator-digest`): one block "spend since last digest" with totals by rung and the five most expensive PRs.
4. `docs/operations/agent-governance-reference.md`: the report, and the Phase 3 budget rule written as the target with the fields this report provides for it.

## Acceptance Criteria

- [x] After one `/ai-sdlc execute` run, `cli-kpi spend --pr <n>` shows developer-round tokens, reviewer tokens and any judgment-layer calls, each tagged with the rung from the caller's frontmatter.
- [x] A rung-2 call below its confidence floor appears with `outcome: escalated` and the rung-3 call that followed is linked to it.
- [x] `cli-decisions operator-digest` prints the spend block; `--mark` resets its window.
- [x] No cap or refusal is introduced anywhere (test asserts the pipeline completes with a spend above any configured value, since none exists).
- [x] Docs name the Phase 3 rule and the fields it needs.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`.

## Out of scope

Any budget enforcement (Phase 3); a development trio (separate RFC, decided from this data).
