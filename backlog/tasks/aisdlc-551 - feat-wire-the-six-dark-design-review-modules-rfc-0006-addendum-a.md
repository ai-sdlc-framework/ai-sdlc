---
id: AISDLC-551
title: >-
  feat(design): wire the six implemented-but-unreachable RFC-0006 Addendum A
  modules into the pipeline and package surfaces
status: To Do
assignee: []
labels:
  - design-system
  - orchestrator
  - reference
  - ci:no-issue-required
priority: medium
dependencies:
  - AISDLC-550
references:
  - reference/src/policy/design-ci.ts
  - reference/src/policy/structural-preprocessor.ts
  - reference/src/policy/design-exemplar-bank.ts
  - orchestrator/src/design-system-metrics.ts
  - orchestrator/src/design-system-correction-loop.ts
  - orchestrator/src/design-quality-trend.ts
  - docs/concepts/design-review-architecture.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-550 documented RFC-0006 Addendum A and, in doing so, established that
**six Addendum A modules are dark code**: each is implemented and unit-tested,
but is not re-exported from any package barrel and is imported by nothing
outside its own test file. They therefore have zero runtime effect today, and
adopters cannot reach them without deep-path imports into package internals.

Verified state (barrel exports + importer scan, 2026-08-10):

| Module | Public API it should expose | Consumers today |
|---|---|---|
| `reference/src/policy/design-ci.ts` | the six Layer 1 checks, `runDesignCI`, `generateDesignCIBoundary` | none |
| `reference/src/policy/structural-preprocessor.ts` | `analyzeStructure`, `computeComplexityScore`, `triggersDesignReview`, `StructuralDesignAnalysis` + supporting types | none |
| `reference/src/policy/design-exemplar-bank.ts` | `DESIGN_REVIEW_PRINCIPLES`, `createExemplarBank`, `parseExemplarsFromYaml`, `ExemplarBank`, `DesignExemplar` | none |
| `orchestrator/src/design-system-metrics.ts` | `computeDesignMetrics` + the five per-metric helpers, `DesignMetrics` | none |
| `orchestrator/src/design-system-correction-loop.ts` | correction-loop + review-feedback surface | none |
| `orchestrator/src/design-quality-trend.ts` | `DesignQualityTrendDegrading` detector | none |

All six have passing unit tests, so this is wiring work, not implementation
work. `UsabilitySimulationRunner` is already exported from the adapters barrel
(with `createStubUsabilitySimulationRunner`) and is out of scope.

## Wiring targets

1. **Export barrels.** Re-export the two `reference` modules from
   `reference/src/policy/index.ts` (the root barrel already does
   `export * from './policy/index.js'`), and the three `orchestrator` modules
   from `orchestrator/src/index.ts`. Decide deliberately which symbols are
   public API versus internal — the concepts doc currently warns adopters that
   these shapes are provisional; whatever is exported stops being provisional.
2. **Design CI → gate invocation.** `design-ci.ts` provides the six checks and
   `generateDesignCIBoundary()`, but there is no `accessibilityAudit` (or
   equivalent) `QualityGate` rule type to invoke them declaratively. Wiring
   means either adding the rule type to the schema or calling `runDesignCI()`
   from the design review path — decide which, and say so in the PR body.
   `generateDesignCIBoundary()` output should reach reviewer prompts so the
   boundary is real rather than prose.
3. **Structural preprocessor → review context.** Its own header states findings
   are "prepended to review context as *Pre-Verified Structural Analysis*".
   Call `analyzeStructure()` in the design review path and prepend the result;
   use `triggersDesignReview()` to decide whether the human gate is needed.
4. **Exemplar bank → reviewer calibration.** The code-review analogue is
   `.ai-sdlc/review-principles.md` + `.ai-sdlc/review-exemplars.yaml`. There is
   no design equivalent on disk, so this includes creating the design exemplar
   YAML and loading it via `parseExemplarsFromYaml()`, then feeding the 7
   principles + exemplars to the design reviewer.
5. **Metrics → autonomy.** `design-system-metrics.ts` says it "integrates them
   into the autonomy evaluation system"; the live integration point is
   `orchestrator/src/autonomy-tracker.ts` (imported by `execute.ts`,
   `orchestrator.ts`, `plugin.ts`). Feed `computeDesignMetrics()` output into
   promotion/demotion evaluation.
6. **Correction loop + trend detector.** Invoke the correction loop on design
   gate failure (RFC-0006 §8.4/§8.5) and schedule the trend detector as the
   periodic monitor it was written to be.

## Scope discipline

Wiring may reveal that a module's signature does not fit its intended call
site. Adapting the call site is in scope; **redesigning a module or resolving an
RFC-0006 open question is not** — escalate instead. If any of the five turns out
to be genuinely unwireable as written, stop at that module, document why in the
PR body, and leave it unexported rather than forcing a fit.

Update `docs/concepts/design-review-architecture.md`'s implementation-status
matrix in the same PR — its rows are the acceptance surface for this work, and
leaving them stale would recreate exactly the drift AISDLC-550 fixed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The two `reference` modules are re-exported from `reference/src/policy/index.ts` and reachable as `@ai-sdlc/reference` imports; the three `orchestrator` modules are reachable from `@ai-sdlc/orchestrator`
- [ ] #2 `analyzeStructure()` runs in the design review path and its findings are prepended to review context; `triggersDesignReview()` gates the human review step
- [ ] #3 A design exemplar YAML exists under `.ai-sdlc/`, is loaded via `parseExemplarsFromYaml()`, and the 7 principles + exemplars reach the design reviewer
- [ ] #4 `computeDesignMetrics()` output feeds autonomy promotion/demotion via `autonomy-tracker.ts`
- [ ] #5 The correction loop is invoked on design gate failure and the trend detector runs as a periodic monitor
- [ ] #6 Each newly wired path has a test proving the wiring (not just the module's pre-existing unit tests) — a test that fails if the export or the call site is removed
- [ ] #7 `docs/concepts/design-review-architecture.md` status matrix updated: every module moved from "Implemented, unwired" to "Wired", or left unwired with a documented reason in the PR body
- [ ] #8 Full verification passes: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm rfc:check`
<!-- AC:END -->

## Note on the upstream-OQ gate (resolved)

Earlier revisions of this task carried a `blocked.reason` override because
RFC-0006 §18 OQ-7 and OQ-8 were unresolved and the upstream-OQ gate blocked every
task citing the RFC. Those OQs were closed by operator walkthrough on 2026-08-13
(§18 is now 0 open), so the override has been removed and this task clears the
gate on its own merit.
