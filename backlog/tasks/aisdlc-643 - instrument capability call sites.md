---
id: AISDLC-643
title: >-
  RFC-0049 section 9: report capability outcomes from every registered seam and from the judgment runtime
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - capability-liveness
  - pipeline-cli
  - orchestrator
dependencies:
  - AISDLC-631
  - AISDLC-642
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/classifier/substrate/classify.ts
  - pipeline-cli/src/dor/composite.ts
  - pipeline-cli/src/decisions/stage-b.ts
  - pipeline-cli/src/decisions/stage-c.ts
  - pipeline-cli/src/estimation/class-assignment.ts
  - pipeline-cli/src/estimation/stage-b.ts
  - orchestrator/src/sa-scoring/layer3-llm.ts
  - orchestrator/src/review-meta.ts
  - orchestrator/src/policy-evaluators.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wires the capability registry from AISDLC-642 to the places where capabilities actually
run, so the state file reflects reality. After this task, running the pipeline in this
repository with nothing configured must show every registered capability as `degraded`
with a reason, which is the true state today. RFC-0049 section 9.2.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`, section 9. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, 80% line coverage on new code.
  Scripts under `scripts/` use `node --test`.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
Reporting must never change what a call site returns. Each site reports exactly once
per invocation.

1. **Classifier substrate** (`pipeline-cli/src/classifier/substrate/classify.ts`): map
   each task type to its capability id. Report `live` when a classification is
   returned and meets the threshold, `degraded` with the reason (`no-invoker`,
   `invoker-error`, `invalid-response`, `below-threshold`) when the `pending` sentinel
   is returned.
2. **DoR Stage B** (`pipeline-cli/src/dor/composite.ts`): `degraded` with reason
   `no-spawner` when Stage A is returned alone; `live` when Stage B verdicts are merged.
3. **Decision Stage B signals** (`pipeline-cli/src/decisions/stage-b.ts`): `degraded`
   with reason `constant` whenever the 0.5 constants are used.
4. **Decision Stage C** (`pipeline-cli/src/decisions/stage-c.ts`): as for the
   substrate, under `decisions.stage-c-recommendation`.
5. **Estimation** (`pipeline-cli/src/estimation/class-assignment.ts` and
   `pipeline-cli/src/estimation/stage-b.ts`): class assignment reports `degraded` with
   reason `regex` when the heuristic decides and nothing when frontmatter decides;
   Stage B reports `degraded` with reason `no-invoker` when Stage A's verdict is used
   in a case where Stage B would have been consulted.
6. **Orchestrator seams:** `sa.layer3` where Layer 3 is skipped for lack of a client
   (`orchestrator/src/sa-scoring/`), `review.meta-review` where no meta-review
   function is supplied, and `policy.llm-evaluator` where the stub evaluator from
   `orchestrator/src/policy-evaluators.ts` is used.
7. **Judgment runtime:** the context builders from AISDLC-631 supply the capability
   callback that AISDLC-630 defined on the evaluation context. For a definition with a
   `capabilityId`: `live` when the effective mode is `enforce` and the outcome is `act`
   or `escalate`; `shadow` when the provider answered in `shadow`; `degraded` with the
   abstain reason otherwise. When a judgment reports for a capability, the legacy call
   site for the same invocation does not also report.
8. **Artifacts directory** is resolved the same way each package already resolves it.

## Acceptance Criteria
- [ ] With nothing configured, exercising each instrumented call site once produces a state file in which every one of the twelve registered capabilities is `degraded` with a non-empty reason.
- [ ] Each call site's return value is identical with reporting enabled and with the state directory unwritable (regression test per site on existing fixtures).
- [ ] The substrate reports `live` with a fake invoker returning a valid above-threshold answer, and `degraded` with the matching reason for a missing invoker, a throwing invoker, an invalid response and a below-threshold answer.
- [ ] DoR reports `degraded` with reason `no-spawner` when no spawner is passed and `live` when a mock spawner supplies Stage B verdicts.
- [ ] A judgment in `shadow` reports `shadow`, a judgment in `enforce` that acts reports `live`, and an abstaining judgment reports `degraded` with the abstain reason.
- [ ] One invocation produces exactly one report per capability, including when a judgment and a legacy site cover the same capability.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
