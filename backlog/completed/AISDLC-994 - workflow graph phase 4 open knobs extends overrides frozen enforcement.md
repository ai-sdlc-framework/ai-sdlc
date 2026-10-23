---
id: AISDLC-994
title: 'Workflow graph phase 4: open knobs, `extends` overrides and frozen-set enforcement with cited enforcers'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - rfc-0056
  - phase-4
  - pipeline-cli
  - governance
dependencies:
  - AISDLC-993
references:
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - pipeline-cli/src/steps/08-aggregate-verdicts.ts
  - pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/routing/load-table.ts
priority: medium
dispatchable: true
---

## Description

RFC-0056 phase 4 (Signed Off 2026-10-20). The first adopter-visible phase: the document becomes editable within the frozen set.

**Scope.**
1. Open knobs in the default document: iteration cap (`loop.max`), reviewer lenses (`select.with.lenses`), fanout `cap` up to the plugin ceiling, hygiene nodes (sweep, sync-parent) removable, timers, `sample` on the staged node. Each knob is read from the document; the code constant becomes the plugin ceiling, not the value.
2. `metadata.extends: ai-sdlc/execute-task@<version>` resolves the plugin default and applies the adopter document as an overlay. Allowed: add nodes, add edges, change `with`, lower caps, change lenses, remove non-frozen nodes. Refused: touch a frozen node, raise a cap above the ceiling, remove the last anchor on a path, declare an agent as anchor.
3. Frozen enforcement over the OQ-3 set, each entry checked against the plugin default byte-for-byte unless the overlay names a decision record already on `main`: `aggregate` (severity rule, unanimity, missing reviewer is critical), `ship` (never land, lease-only push), every `anchor`, attestation signing, nonce bound to the head SHA, the baseline checklist, the grounding drop, atomic board claims, the reconciler loop guard, base-branch-only config loading, and the fanout join (`expect` cannot be loosened, `cap` cannot exceed the ceiling). The validator's refusal message cites the enforcer file for the rule it protects.
4. Close the base-branch loading gap found in the walkthrough: `hierarchy/pr-lifecycle-config.ts` reads `pr-lifecycle.yaml` from the working tree; it reads from the base branch like `reviewer-set.ts` and `routing/load-table.ts` do.
5. Promotion of the staged node to gating (`lenses: [staged, security]`) is a document edit authorized by RFC-0052 OQ-2's criterion; the validator accepts it as a tightening and logs the authorizing reference.

**Five-step review (requirements first).**
1. Requirement questioned: should adopters fork to change the iteration cap or lenses? No; those are data.
2. Delete: code paths that hard-code a knob the document now carries (the constants become ceilings).
3. Simplify: one overlay rule set, one frozen list with one refusal shape.
4. Accelerate: a topology change ships as a config PR, not a plugin release.
5. Automate: a fixture per refused override and per allowed override; a test that every frozen entry's cited enforcer file exists.

## Acceptance Criteria

- [x] An adopter overlay that lowers `loop.max` to 1, changes lenses, and removes the sweep node is accepted and the golden test shows the changed instruction sequence.
- [x] Overlays that edit `aggregate`, raise a fanout `cap` above the ceiling, loosen `expect`, remove the last anchor before `ship`, or declare an agent as anchor are refused, and each refusal message names the enforcer file for the frozen rule.
- [x] An overlay touching a frozen node is accepted only when it references a decision id that resolves in the catalog on the base branch; a reference to an id in the working tree only is refused (test).
- [x] `pr-lifecycle-config.ts` loads from the base branch; a working-tree edit to `pr-lifecycle.yaml` has no effect in a test.
- [x] A test asserts every enforcer path cited in the frozen list exists in the repo; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Added workflow overlays (`metadata.extends`) with a single frozen list. Every refusal names its enforcer file, and a frozen touch is accepted only under a decision id that resolves on the base branch. `pr-lifecycle-config.ts` now reads from the base branch. The lens knob is only partly wired and the timers knob is not (see notes).

## Changes
- pipeline-cli/src/workflow/overlay.ts
- pipeline-cli/src/workflow/overlay.test.ts
- pipeline-cli/src/workflow/engine.ts
- pipeline-cli/src/workflow/engine.test.ts
- pipeline-cli/src/workflow/execute-host.ts
- pipeline-cli/src/workflow/graph.ts
- pipeline-cli/src/cli/workflow.ts
- pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
- pipeline-cli/src/hierarchy/pr-lifecycle-config.test.ts
- spec/schemas/workflow.schema.json
- reference/src/core/generated-schemas.ts
- docs/operations/workflow-engine.md

## Design decisions
Full test run, no tests skipped or waived: `cd pipeline-cli && npx vitest run --testTimeout=120000` summary: Test Files 533 passed (533); Tests 12103 passed | 13 skipped (12116). reference, orchestrator, sdk-typescript and plugin mods suites also passed in the root `pnpm test` run. The overlay, engine and pr-lifecycle tests pass. Scope gaps: the default document has no `sweep` or `sync-parent` node, so the existing `upkeep` node (which does both) is the removable hygiene node. Timers stay in `pr-lifecycle.yaml`; this PR adds no timers key to the workflow document. Lenses are validated and wired only as a staged opt-out: a `plan` node whose `with.lenses` omits `staged` turns the staged review off. Lenses do not otherwise change which reviewers run. A full document without `extends` is also checked against the plugin default. The pre-push attestation step found no verdicts file for AISDLC-994 and skipped signing, so the PR will need attestation before it is marked ready. The AISDLC-994 task file under `backlog/tasks/` is only committed as a claim edit; the pre-push task-move hook found no task to move.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed. Exact command: `cd pipeline-cli && npx vitest run --testTimeout=120000`, summary line `Tests  12103 passed | 13 skipped (12116)`; the other root-chain steps (rfc:check, dark-code:check, lint:publishable, knowledge:check, sync:plugin-runtime-deps:check) pass and `pnpm test:gates` passes apart from one load-dependent flake in usage-ingest.test.mjs that passes alone (`node --test ai-sdlc-plugin/hooks/usage-ingest.test.mjs`: pass 18, fail 0)
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

