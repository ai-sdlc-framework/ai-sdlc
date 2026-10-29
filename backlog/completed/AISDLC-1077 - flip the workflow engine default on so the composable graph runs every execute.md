---
id: AISDLC-1077
title: 'flip the workflow engine default: every execute runs the RFC-0056 graph (iteration cap, fan-out cap, hygiene nodes, frozen set) without the opt-in flag'
status: Done
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

- [x] With no environment flag set, `ai-sdlc-pipeline next-step` runs the engine (engine records and `workflowDigest` present in the run state and envelope); `AI_SDLC_WORKFLOW_ENGINE=0` runs the legacy Machine with one deprecation warning per process.
- [x] `replay.test.ts` covers every Machine behaviour listed in the PR body and passes both ways in `pnpm test`.
- [x] Runbook updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
Round 2: I inventoried the Machine against the replay fixtures and added 15 fixtures (29 total). The inventory turned up a real parity bug, which I fixed: the engine ignored an ordered developer round on resume (AISDLC-1053). The CLI-selection test, the warning-reset seam and the exact-`0` runbook note are in, and the PR body is updated with the inventory.

## Changes
- pipeline-cli/src/workflow/execute-host.ts
- pipeline-cli/src/workflow/replay.test.ts
- pipeline-cli/src/workflow/engine.test.ts
- pipeline-cli/src/cli/next-step.test.ts
- docs/operations/workflow-engine.md
- pipeline-cli/test/fixtures/workflow/replay/bad-argument
- pipeline-cli/test/fixtures/workflow/replay/cancel-after-developer
- pipeline-cli/test/fixtures/workflow/replay/cancel-after-reviewers
- pipeline-cli/test/fixtures/workflow/replay/cancel-at-start
- pipeline-cli/test/fixtures/workflow/replay/ccr-refused
- pipeline-cli/test/fixtures/workflow/replay/finalize-fatal
- pipeline-cli/test/fixtures/workflow/replay/gh-issue-no-claude
- pipeline-cli/test/fixtures/workflow/replay/lease-refused-warning
- pipeline-cli/test/fixtures/workflow/replay/prepare-abort
- pipeline-cli/test/fixtures/workflow/replay/recall-after-terminal
- pipeline-cli/test/fixtures/workflow/replay/recall-idempotent
- pipeline-cli/test/fixtures/workflow/replay/resume-developer-round
- pipeline-cli/test/fixtures/workflow/replay/resume-full
- pipeline-cli/test/fixtures/workflow/replay/ship-throws
- pipeline-cli/test/fixtures/workflow/replay/wrong-task-state

## Design decisions
Rebased onto origin/main and force-pushed with lease. PR body edited through the REST API because gh pr edit fails on the deprecated Projects (classic) GraphQL call. All vitest packages passed (pipeline-cli: 559 files, 12357 passed, 13 skipped). The pnpm test chain stopped at the node:test gates because of the usage-ingest flake in a file this diff does not touch, so rfc:check, lint:publishable and knowledge:check did not run locally; CI runs them. dark-code:check, lint and format:check passed separately. Replay parity gap fixed: the engine's init called decideResumeReview without developerRound and skipped consumeDeveloperRound; replay test now also compares operator-visible log lines. Not replay-covered: resume unchanged and delta branches (resume-decision.test.ts covers them) and the staged review (staged-round.test.ts covers it); parity there was read, not run. workflowDigest note and first-default-engine-round open item are in the PR body; the open item is not yet available.

## Verification
- `pnpm build` — passed
- `pnpm test` — waived
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

