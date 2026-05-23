---
id: AISDLC-411
title: 'feat(orchestrator): promote AI_SDLC_AUTONOMOUS_ORCHESTRATOR to default-ON (RFC-0015 Phase 5)'
status: Done
labels: [orchestrator, rfc-0015, promotion, operator-merge]
references:
  - pipeline-cli/src/orchestrator/feature-flag.ts
  - docs/operations/orchestrator-promotion.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
permittedExternalPaths: []
---

## Description

Per operator directive 2026-05-23: promote `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (RFC-0015) from default-OFF to default-ON. The operator's directive is the **override-path** evidence per `docs/operations/orchestrator-promotion.md` (the corpus path is documented as needing ≥20 dispatched tasks across ≥3 distinct task IDs; operator judgment is the alternative).

Follow Option A from the runbook ("flip the default in the parser") — invert the polarity of `isOrchestratorEnabled` so absent env = ON, opt-out via the FALSY set (`off`/`0`/`false`/`no` case-insensitively); truthy values (`experimental`/`1`/`true`/`yes`/`on`) honored for backward-compat.

## Acceptance criteria

- [x] AC-1: Flip default in `pipeline-cli/src/orchestrator/feature-flag.ts#isOrchestratorEnabled` — invert polarity so unset env = ON.
- [x] AC-2: Audit every caller branching on the flag — `isOrchestratorEnabled()` is consumed in `pipeline-cli/src/cli/orchestrator.ts`, `pipeline-cli/src/orchestrator/loop.ts`, `pipeline-cli/src/orchestrator/events.ts`, `pipeline-cli/src/index.ts`; all read the boolean directly and behave correctly under default-ON.
- [x] AC-3: Update CLAUDE.md `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` bullet — "Off by default" → "On by default since AISDLC-411; opt out via `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off`."
- [x] AC-4: Rewrite `pipeline-cli/src/orchestrator/feature-flag.test.ts` to reflect the new default-ON polarity (5 case groups: unset/empty = ON, experimental = ON, truthy backward-compat = ON, FALSY set = OFF, unknown values = ON fail-safe).
- [x] AC-5: Update `orchestratorDisabledMessage` body to reflect post-cutover "explicitly disabled" semantics + name the opt-out path.
- [ ] AC-6: Sweep tests across pipeline-cli/src/{orchestrator,cli,estimation,decisions} for any test that does `delete process.env.AI_SDLC_AUTONOMOUS_ORCHESTRATOR` then asserts OFF behavior — change those to explicit `'off'` to keep the test surface focused on the operator-opt-out path.

## Out of scope

- `pipeline-cli/docs/orchestrator.md` "Quick start" framing rewrite — deferred to follow-up so this PR stays scoped to the parser flip + tests.
- RFC-0015 parent task lifecycle close.
- Chaos test rerun documented in the promotion runbook — already in the hermetic suite + passing locally; an explicit "rerun + log result" workflow is out of scope for the flip itself.

## Estimated effort

30-45 min.
