---
id: AISDLC-1077
title: 'flip the workflow engine default: every execute runs the RFC-0056 graph (iteration cap, fan-out cap, hygiene nodes, frozen set) without the opt-in flag'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - token-cost
  - rfc-0056
priority: critical
dispatchable: true
dependencies: []
rfc: RFC-0056
references:
  - pipeline-cli/src/workflow/execute-host.ts
  - pipeline-cli/src/workflow/replay.test.ts
  - pipeline-cli/test/fixtures/workflow/replay/
  - docs/operations/workflow-engine.md
---

## Description

The workflow graph audit of 2026-10-18 became RFC-0056 (Signed Off 2026-10-20) and its four phases landed (AISDLC-991 to 995): step metadata and the graph oracle, the schema and manifest entry, the engine with golden replay and `workflowDigest`, and the open knobs (iteration cap, review fan-out cap, hygiene nodes, timers, `extends` overrides, frozen-set enforcers). The engine still runs only when `AI_SDLC_WORKFLOW_ENGINE=1` is set (`WORKFLOW_ENGINE_FLAG` in `execute-host.ts`); `docs/operations/workflow-engine.md` says "the default flips in a follow-up" and names the gate: `replay.test.ts` must drive both paths over every fixture with identical instruction sequences, exit codes and collaborator calls, with a fixture for every Machine behaviour. No follow-up task was filed and nothing in the repository, the launcher or the executor command sets the flag, so every production `/ai-sdlc execute` round still runs the legacy Machine and none of the audit's token controls (bounded iterations, capped fan-out, hygiene nodes) apply. The weekly token audit of 2026-10-23 makes those controls the point.

Fix: (1) inventory the Machine behaviours against the replay fixtures and add the missing fixtures (list them in the PR body); (2) make the engine the default and keep `AI_SDLC_WORKFLOW_ENGINE=0` as the one-release escape hatch with a deprecation line in the runbook; (3) make the replay test run in `pnpm test` both ways; (4) the attestation envelope of a default-engine run carries `workflowDigest`, and `scripts/verify-attestation.mjs` is not touched (blocked path) unless the digest check already lives there, in which case the change is a config value only; (5) runbook: the default section, the escape hatch, and how to read a run's engine records. Report in the PR body the first executor round that ran on the default engine (task id, PR, envelope path).

**Five-step review (requirements first).** Requirement questioned: is the flag still needed at all? Only as a one-release escape hatch; the parallel Machine is the thing to delete next. Deletion: the opt-in. Simplified: one orchestrator path in production. Accelerated: the iteration and fan-out caps bound every round's token cost. Automated last: the replay test gates both paths in CI.

## Acceptance Criteria

- [ ] With no environment flag set, `ai-sdlc-pipeline next-step` runs the engine (engine records and `workflowDigest` present in the run state and envelope); `AI_SDLC_WORKFLOW_ENGINE=0` runs the legacy Machine with one deprecation warning per process.
- [ ] `replay.test.ts` covers every Machine behaviour listed in the PR body and passes both ways in `pnpm test`.
- [ ] Runbook updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
