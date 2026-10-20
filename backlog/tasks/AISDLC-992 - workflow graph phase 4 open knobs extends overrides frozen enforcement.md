---
id: AISDLC-992
title: 'Workflow graph phase 4: open knobs, `extends` overrides and frozen-set enforcement with cited enforcers'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - rfc-0056
  - phase-4
  - pipeline-cli
  - governance
dependencies:
  - AISDLC-991
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

- [ ] An adopter overlay that lowers `loop.max` to 1, changes lenses, and removes the sweep node is accepted and the golden test shows the changed instruction sequence.
- [ ] Overlays that edit `aggregate`, raise a fanout `cap` above the ceiling, loosen `expect`, remove the last anchor before `ship`, or declare an agent as anchor are refused, and each refusal message names the enforcer file for the frozen rule.
- [ ] An overlay touching a frozen node is accepted only when it references a decision id that resolves in the catalog on the base branch; a reference to an id in the working tree only is refused (test).
- [ ] `pr-lifecycle-config.ts` loads from the base branch; a working-tree edit to `pr-lifecycle.yaml` has no effect in a test.
- [ ] A test asserts every enforcer path cited in the frozen list exists in the repo; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
