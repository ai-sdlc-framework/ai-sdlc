---
id: AISDLC-1281
title: '`ai-sdlc init` scaffolds a pipeline without the deprecated `spec.stages`, so a fresh config loads without a warning'
status: To Do
assignee: []
created_date: '2026-11-16'
labels:
  - orchestrator
  - pipeline-cli
  - adopter
  - bug
dependencies:
  - AISDLC-1280
references:
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/init-template-schema.test.ts
  - pipeline-cli/src/config-manifest/manifest.ts
  - orchestrator/src/config.ts
  - orchestrator/src/execute.ts
  - orchestrator/src/fix-ci.ts
  - orchestrator/src/fix-review.ts
  - docs/getting-started/README.md
priority: medium
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2679), second of two tasks. Verified by the planner in source at main 1ffab4a1: both scaffold templates write a `stages:` block and `warnStagesDeprecated` in `orchestrator/src/config.ts` warns on it. Depends on AISDLC-1280, which makes the field optional in the schema. The operator chose the full fix on 2026-11-16.'
---

## Description

**Gap (issue #2679).** `ai-sdlc init` writes a `.ai-sdlc/pipeline.yaml` that sets `spec.stages`. `ai-sdlc health` and `ai-sdlc status` then print, about a file init has just written:

```
[ai-sdlc] deprecated: pipeline.yaml sets spec.stages; pipeline-cli never executed it and the Workflow document (.ai-sdlc/workflow.yaml, RFC-0056) replaces it. It is accepted for one release, then removed.
```

Two scaffolders write the block:

- `orchestrator/src/cli/commands/init.ts` (the `stages:` block of the pipeline template, about lines 77-89);
- `pipeline-cli/src/config-manifest/manifest.ts` (`cli-init`, about lines 114-127).

Three orchestrator readers use the field without a guard for its absence: `orchestrator/src/execute.ts` (about line 897), `orchestrator/src/fix-ci.ts` (about line 196) and `orchestrator/src/fix-review.ts` (about line 219), each as `config.pipeline?.spec.stages.find(...)`.

**Shape.** Neither template writes `stages`. The three readers behave, for a Pipeline without `stages`, exactly as they do today when no stage of the wanted name exists.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does a new adopter need a `stages` block? No: it is deprecated and nothing in pipeline-cli executes it. 2. Deleted: the block from both templates. 3. Simplified or optimised: readers use `spec.stages?.find(...)`; no new default objects. 4. Accelerated: n/a. 5. Automated: a test runs the config loader on the scaffolded template and asserts no warning.

- Remove the `stages:` block from the pipeline template in `init.ts` and from the template in `manifest.ts`.
- `execute.ts`, `fix-ci.ts`, `fix-review.ts`: read `stages` with optional chaining. The values taken from the stage (timeout, retry settings and the like) keep their current fallback for "no such stage".
- `warnStagesDeprecated` is unchanged: an existing adopter file that still sets `stages` keeps its one warning.
- `docs/getting-started/README.md`: if its pipeline example shows `stages`, remove the block or mark it deprecated.

## Acceptance Criteria

- [ ] #1 After `ai-sdlc init --yes` in a new repository, `ai-sdlc health` and `ai-sdlc status` write no `spec.stages` deprecation warning to stderr; a test loads the scaffolded template through `loadConfig` and asserts `console.warn` is not called with that text.
- [ ] #2 `ai-sdlc validate` reports the scaffolded `pipeline.yaml` as VALID (`init-template-schema.test.ts` passes on the new template).
- [ ] #3 The `cli-init` template in `pipeline-cli/src/config-manifest/manifest.ts` contains no `stages:` block and validates against the Pipeline schema; a test covers it.
- [ ] #4 `execute`, `fix-ci` and `fix-review` run on a config whose Pipeline has no `stages` without throwing; one test per reader, or a shared one, covers it.
- [ ] #5 A Pipeline that sets `stages` behaves as today in the three readers; existing tests pass unchanged.
- [ ] #6 The PR body carries `Closes #2679`.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
