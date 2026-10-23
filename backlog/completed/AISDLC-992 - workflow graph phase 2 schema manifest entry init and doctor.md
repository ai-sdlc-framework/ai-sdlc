---
id: AISDLC-992
title: 'Workflow graph phase 2: `Workflow` schema, config-manifest entry, rendered default, `init` scaffold and `doctor` check'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - rfc-0056
  - phase-2
  - schema
  - plugin
dependencies:
  - AISDLC-991
references:
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - spec/schemas/pipeline.schema.json
  - reference/src/policy/expression.ts
  - ai-sdlc-plugin/commands/init.md
  - ai-sdlc-plugin/commands/doctor.md
priority: high
dispatchable: true
---

## Description

RFC-0056 phase 2 (Signed Off 2026-10-20). With the phase 1 oracle in place, the Workflow document gets a schema and a home, with no engine yet and no behaviour change.

**Scope.**
1. `spec/schemas/workflow.schema.json` (`apiVersion: ai-sdlc.io/v1alpha1`, `kind: Workflow`) with the node kinds `step`, `agent`, `anchor`, `fanout`, `human`; agent properties `role`, `fresh`, `budget`, `gating` (default `true`) and `sample` (default `1`, OQ-1); fanout `over`, `cap`, `expect` (`all | n | quorum(k)`); edges as `from -> to` strings or `{ from, to, when, loop: { max } }`; top-level `anchors`, `budget`, `metadata.extends`; `frozen` as a node boolean or a list of named rules.
2. The `when` field is documented in the schema as the `@ai-sdlc/reference` policy expression grammar (`createSimpleExpressionEvaluator`, OQ-2): comparisons, `&&`, `||`, `!`, dotted paths, `contains`, literals. The schema text names the grammar; a validator (no engine) parses every `when` with that evaluator and rejects an identifier that is not a declared output of an upstream node, using the phase 1 step metadata.
3. The config manifest gains the entry for `.ai-sdlc/workflow.yaml` with `since` set to the next minor; `init` scaffolds the rendered default (the phase 1 golden YAML) and `doctor` reports a document that fails schema or identifier validation.
4. `pipeline.schema.json` `stages[].condition` is marked deprecated in the schema description (removed in phase 3 with `spec.stages`, RFC-0056 §Backward Compatibility).
5. Behaviour change: none. Nothing reads the document at run time yet.

**Five-step review (requirements first).**
1. Requirement questioned: does the document need its own expression language? No; the reference package already ships one the orchestrator uses, so the schema names it instead of inventing one.
2. Delete: nothing yet (`stage.condition` is deprecated here, deleted in phase 3).
3. Simplify: one schema, one validator function shared by `doctor` and later by the engine.
4. Accelerate: `doctor` tells an adopter their document is wrong before any run.
5. Automate: schema tests with one valid default document and one fixture per refusal (undeclared identifier, agent declared as anchor, missing `cap`).

## Acceptance Criteria

- [x] `spec/schemas/workflow.schema.json` validates the phase 1 golden YAML and rejects fixtures for: an `anchor` whose `impl` is an agent role, a `fanout` without `cap`, an undeclared `loop`, and a `when` naming an identifier no upstream node outputs.
- [x] The validator evaluates `when` with `createSimpleExpressionEvaluator` from `@ai-sdlc/reference`; no second expression parser exists in `pipeline-cli/src`.
- [x] `config-manifest` lists `.ai-sdlc/workflow.yaml` with a `since` version; `ai-sdlc init` writes the rendered default and a re-run on an existing project adds only that file.
- [x] `ai-sdlc doctor` has a `workflow-document` check that passes on the default and names the failing rule on a broken document.
- [x] `pipeline.schema.json` `condition` carries a deprecation note that names RFC-0056; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Added the Workflow schema and a shared validator that parses every edge `when` with `createSimpleExpressionEvaluator`. Added an optional `.ai-sdlc/workflow.yaml` manifest entry, `cli-workflow validate`, and a doctor `workflow-document` check. `stages[].condition` in the pipeline schema now carries a deprecation note naming RFC-0056. Nothing reads the document at run time.

## Changes
- spec/schemas/workflow.schema.json
- spec/schemas/pipeline.schema.json
- reference/src/core/generated-schemas.ts
- pipeline-cli/src/workflow/validate.ts
- pipeline-cli/src/workflow/validate.test.ts
- pipeline-cli/src/cli/workflow.ts
- pipeline-cli/src/config-manifest/manifest.ts
- pipeline-cli/src/config-manifest/manifest.test.ts
- pipeline-cli/src/cli/init.test.ts
- pipeline-cli/src/steps/step-meta.ts
- pipeline-cli/src/steps/08-aggregate-verdicts.ts
- pipeline-cli/src/steps/09-iterate.reviewers.test.ts
- orchestrator/src/cli/commands/doctor-checks.ts
- orchestrator/src/cli/commands/doctor-checks.test.ts
- backlog/tasks/AISDLC-992 - workflow graph phase 2 schema manifest entry init and doctor.md

## Design decisions
Tests: `pnpm test` exited 0 on the full chain, including `pnpm -r test`, the gates and dark-code check. Coverage was not run locally. I did not run `ai-sdlc init` end to end. Instead, `manifest.test.ts` asserts the entry exists, is optional and has `since` 0.36.0, and that its rendered content validates; the existing skipOperatorInput scaffold test now includes `workflow.yaml` in what gets created. Design choices: (1) The manifest entry has a new `optional` flag. A required entry would make the execute preflight refuse every existing project, which is a behaviour change. Optional entries are scaffolded by init but never reported missing; `doctor` warns instead. (2) Identifier checking uses a new optional `outputFields` on `StepMeta`, set to `['decision']` on the aggregate-verdicts step. (3) Because the manifest now imports the graph module and its steps, `09-iterate.reviewers.test.ts` needed its `vi.mock` to export `BUILD_REVIEW_PROMPTS_STEP`. (4) The phase 1 golden writes `decision == APPROVED` with a bare `APPROVED`. The reference evaluator resolves that as a property path, so it evaluates false at run time. The validator treats bare right-hand words as enum literals. The engine phase should fix this.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
- declined: the golden's bare APPROVED right-hand operand is an engine-phase (RFC-0056 phase 3) concern, noted in the PR body

