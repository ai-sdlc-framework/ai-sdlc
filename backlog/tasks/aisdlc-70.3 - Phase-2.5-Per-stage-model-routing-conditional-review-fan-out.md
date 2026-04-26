---
id: AISDLC-70.3
title: 'Phase 2.5: Per-stage model routing + conditional review fan-out'
status: In Progress
assignee: []
created_date: '2026-04-26 19:45'
updated_date: '2026-04-26 20:28'
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
- [ ] #1 Schema additions: Stage.model, Stage.kind, Stage.maxBudgetUsd, Pipeline.spec.defaultModel (RFC §6.3, §6.4)
- [ ] #2 Model alias registry implemented at orchestrator/src/models/registry.ts with resolution function pinned at pipeline-load (RFC §11.1)
- [ ] #3 Model deprecation lifecycle: deprecatedAt/removedAt/replacementAlias per registry entry; pipeline-load emits ModelDeprecated/ModelRemoved events per RFC §11.6 (Q5)
- [ ] #4 cli-model-bump --dry-run command implemented per RFC §11.6 operator workflow (Q5)
- [ ] #5 Update ai-sdlc-plugin/agents/{code,test,security}-reviewer.md to use model: inherit
- [ ] #6 Update ai-sdlc-plugin/commands/triage.md to use model: haiku
- [ ] #7 Cost-governance ledger amended with modelId column (orchestrator/src/cost-governance.ts) per RFC §11.4
- [ ] #8 review-classifier and review-fanout stage kinds implemented per RFC §12.1, including the confident: bool + confidence: float schema with consistency validation (Q4)
- [ ] #9 Classifier calibration log written to $ARTIFACTS_DIR/_classifier/calibration.jsonl per RFC §12.3 (Q4)
- [ ] #10 cli-classifier-feedback <pr> --add-reviewer <r> --reason <text> command for ground-truth attribution (Q4)
- [ ] #11 Integration test: docs-only PR runs only [critic], auth-touching PR runs all three with security bumped to Opus per modelOverride
- [ ] #12 New code reaches 80%+ patch coverage
<!-- AC:END -->
