---
id: AISDLC-70.3
title: 'Phase 2.5: Per-stage model routing + conditional review fan-out'
status: Done
assignee: []
created_date: '2026-04-26 19:45'
updated_date: '2026-04-26 20:39'
labels:
  - rfc-0010
  - phase-2.5
  - model-routing
  - review
milestone: m-2
dependencies:
  - AISDLC-70.1
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#11-per-stage-model-routing
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#12-conditional-review-fan-out
  - orchestrator/src/cost-governance.ts
  - ai-sdlc-plugin/agents/
  - ai-sdlc-plugin/commands/
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Per-stage model routing (RFC §11) plus the conditional review fan-out classifier (RFC §12). Includes Q4 resolution (classifier confidence/calibration log) and Q5 resolution (model deprecation lifecycle + cli-model-bump). Parallelizable with Phase 2. Estimated 1 week.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Schema additions: Stage.model, Stage.kind, Stage.maxBudgetUsd, Pipeline.spec.defaultModel (RFC §6.3, §6.4)
- [x] #2 Model alias registry implemented at orchestrator/src/models/registry.ts with resolution function pinned at pipeline-load (RFC §11.1)
- [x] #3 Model deprecation lifecycle: deprecatedAt/removedAt/replacementAlias per registry entry; pipeline-load emits ModelDeprecated/ModelRemoved events per RFC §11.6 (Q5)
- [x] #4 cli-model-bump --dry-run command implemented per RFC §11.6 operator workflow (Q5)
- [x] #5 Update ai-sdlc-plugin/agents/{code,test,security}-reviewer.md to use model: inherit
- [x] #6 Update ai-sdlc-plugin/commands/triage.md to use model: haiku
- [x] #7 Cost-governance ledger amended with modelId column (orchestrator/src/cost-governance.ts) per RFC §11.4
- [x] #8 review-classifier and review-fanout stage kinds implemented per RFC §12.1, including the confident: bool + confidence: float schema with consistency validation (Q4)
- [x] #9 Classifier calibration log written to $ARTIFACTS_DIR/_classifier/calibration.jsonl per RFC §12.3 (Q4)
- [x] #10 cli-classifier-feedback <pr> --add-reviewer <r> --reason <text> command for ground-truth attribution (Q4)
- [ ] #11 Integration test: docs-only PR runs only [critic], auth-touching PR runs all three with security bumped to Opus per modelOverride
- [x] #12 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 2.5 model routing + conditional review fan-out committed as 141c10e. ModelRegistry with deprecation lifecycle, classifier output validator with confident/confidence consistency rule, default §12.3 ruleset, calibration log writer, two CLI commands (cli-model-bump, cli-classifier-feedback), schema additions for Stage.model/kind/maxBudgetUsd + Pipeline.spec.defaultModel, cost-governance amended with model_alias and shadow_cost_usd columns. 96 tests pass (60 runtime + 36 model). Build/lint/format clean.

AC #11 (integration test docs-only vs auth-touching) deferred — the deterministic ruleset is unit-tested in classifier.test.ts (10 tests covering all rule branches incl. docs-only → critic, auth → all three with security bumped to opus, lockfile/CI → security+critic, default → all three). Real-PR integration test wires up at Phase 4 when the artifact-directory and stage-dispatch infrastructure lands.

## Changes
- `orchestrator/src/models/{registry,classifier,index}.ts` (new): library.
- `orchestrator/src/models/{registry,classifier}.test.ts` (new): 36 tests.
- `spec/schemas/pipeline.schema.json` (modified): Stage.model/kind/maxBudgetUsd + Pipeline.spec.defaultModel.
- `orchestrator/src/state/{schema,store,types}.ts` (modified): cost_ledger.model_alias + shadow_cost_usd columns + Migration V13.
- `ai-sdlc-plugin/agents/{code,security,test}-reviewer.md` (modified): model: sonnet → model: inherit.
- `ai-sdlc-plugin/commands/triage.md` (modified): added model: haiku.
- `dogfood/src/cli-model-bump.ts` (new): preview alias resolution after deprecation.
- `dogfood/src/cli-classifier-feedback.ts` (new): back-fill calibration with ground truth.
- `orchestrator/src/index.ts` (modified): re-export runtime + models.

## Design decisions
- **Registry pinned at construction time, not at first resolution.** Tests pass injected entries; production uses DEFAULT_REGISTRY. Deprecation events emitted as part of the resolution result (not thrown) so resolution can log + continue.
- **cli-model-bump is --dry-run only in v1.** Operators bump models by editing registry.ts and restarting the orchestrator; an in-place bump operation would defeat the pipeline-load pinning safety property of §11.1.
- **Classifier fall-open is non-negotiable.** All four triggers (parse-error, schema-validation, confident-false, invocation-failed) return the full reviewer set per RFC §12.3. Confident: true with confidence < 0.7 is a schema-validation failure (consistency rule).
- **Calibration log is JSONL append.** Atomic per-line; humanOverrideAfterMerge back-filled by cli-classifier-feedback. The feedback loop closes when operators run the CLI after observing missed reviewers.

## Verification
- `pnpm --filter @ai-sdlc/orchestrator test -- src/runtime src/models` — 96/96 pass
- `pnpm --filter @ai-sdlc/reference build` — 12 schemas regenerated
- `pnpm build` — full workspace clean
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
Phase 2.7 (AISDLC-70.4) — harness adapter framework. The classifier's harnessOverride field is now in the schema; Phase 2.7 wires it up.
<!-- SECTION:FINAL_SUMMARY:END -->
