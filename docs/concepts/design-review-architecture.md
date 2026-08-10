# Design Review Architecture

**Document type:** Informative
**RFC:** [RFC-0006 — Design System Governance Pipeline](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md), Addendum A
**Status:** Implemented (partially — see [Implementation status](#implementation-status))

---

## The problem

Design review as usually practiced is analogous to pre-linting code review: a
senior designer checks everything in one pass — accessibility violations, token
compliance, spacing consistency, typography adherence, interactive state
completeness, usability, *and* aesthetic quality. That bundles mechanical checks
(which have deterministic pass/fail answers) with judgment calls (which require
human expertise), so the highest-value design judgment ends up buried under
routine verification.

AI-SDLC already solved the equivalent problem for code review with a CI
boundary: deterministic tools handle lint, typecheck and coverage; a structural
preprocessor handles complexity analysis; LLM agents review only what remains.
Addendum A applies the same layering to design.

## The four layers

```
Component + Storybook Story
  │
  ├─→ [Deterministic] Design CI — accessibility, tokens, spacing, type scale, states
  │     └─→ Pass/fail; no human or AI review needed
  │
  ├─→ [Deterministic] Structural Design Preprocessor — complexity, completeness, grid
  │     └─→ Structural findings, prepended to review context
  │
  ├─→ [AI Agent] Usability Simulation — browser-based task completion testing
  │     ├─→ Structured findings with confidence scores + evidence
  │     ├─→ Confidence filtering (below 0.5 suppressed)
  │     └─→ Meta-review (medium confidence → lightweight verification)
  │
  └─→ [Human] Design Lead Review — only what survives every automated layer
        └─→ Aesthetic quality, brand consistency, visual rhythm,
            contextual fit, design language coherence
```

The governing rule is the same one the code-review pipeline uses: **never ask a
human — or an LLM — for something a linter can answer.**

### Layer 1 — Design CI boundary

Every design review prompt (agent or human) receives a **Design CI Boundary**
section listing exactly which checks automation already handled, and instructs
the reviewer to skip those categories. This is what stops reviewers
re-litigating contrast ratios instead of evaluating design.

`reference/src/policy/design-ci.ts` implements all six checks
(`checkAccessibility`, `checkTouchTargets`, `checkTypographyScale`,
`checkSpacingGrid`, `checkColorPalette`, `checkStateCompleteness`) plus
`runDesignCI()` and `generateDesignCIBoundary()` — the function that renders the
boundary text reviewers receive. That module is currently unwired (see
[Implementation status](#implementation-status)).

The checks that run declaratively today do so as `QualityGate` rules:

| Category | Method | Enforcement |
|---|---|---|
| WCAG AA accessibility, contrast, ARIA, focus | axe-core / Pa11y | hard-mandatory |
| Token compliance (color, spacing, typography) | `designTokenCompliance` rule | hard-mandatory |
| Touch target size (44px) | interactive-element validation | hard-mandatory |
| Colour palette compliance | palette compliance checking | hard-mandatory |
| Typography scale, spacing grid | scale / grid linting | soft-mandatory |
| Interactive state completeness | `storyCompleteness` rule | soft-mandatory |
| Visual regression | `visualRegression` rule + `VisualRegressionRunner` | per binding |

### Layer 2 — Structural design preprocessor

Deterministic structural analysis (component complexity, story completeness,
grid adherence) whose findings are *prepended to the review context* rather than
gating the pipeline. It gives the later layers evidence instead of asking them
to derive it.

Implemented as `analyzeStructure()` / `computeComplexityScore()` /
`triggersDesignReview()` in `reference/src/policy/structural-preprocessor.ts` —
but not yet exported or called by the pipeline (see
[Implementation status](#implementation-status)).

### Layer 3 — AI agent usability simulation

Rather than asking an LLM whether a design "looks good", this layer drives a
real browser and measures whether a simulated persona can **complete a task**.
Findings carry confidence scores and an action trace as evidence; findings below
0.5 confidence are suppressed, and medium-confidence findings get a lightweight
meta-review pass before surfacing.

The adapter contract is [`UsabilitySimulationRunner`](../api-reference/design-system.md):
`deployStory()` returns a `BrowserSession`, and the agent observes `PageState`
snapshots as it attempts the task.

### Layer 4 — Human design judgment

What reaches the design lead is only what no earlier layer could settle:
aesthetic quality, design-language consistency, contextual fit within a page or
flow, and visual rhythm and hierarchy. Everything above those four rows in the
Design CI boundary table has already been resolved.

## The 7 design review principles

Both AI and human reviewers are calibrated against seven principles, exported as
`DESIGN_REVIEW_PRINCIPLES` from `@ai-sdlc/reference`:

| Principle | Rule |
|---|---|
| **Evidence-First** | Trace the user's path or don't flag it. A usability issue without an action trace is not a valid finding. |
| **Deterministic-First** | Defer to Design CI for accessibility, tokens, spacing, type scale, state completeness. Don't duplicate automated checks. |
| **Context Awareness** | Evaluate the component in its page/flow context. Something that works in Storybook but breaks visual rhythm on the real page is a valid finding. |
| **Severity Honesty** | No failure scenario = not critical/major. Task completed but one extra step taken is minor at most. |
| **Signal Over Noise** | One well-evidenced usability finding beats ten vague aesthetic observations. |
| **Persona Grounding** | Findings must name the persona that experienced the issue. An issue only reachable by a high-tech-confidence persona behaving non-standardly is advisory. |
| **Scope Discipline** | Don't flag choices consistent with the established design language. The simulation tests usability, not aesthetic preference. |

## The exemplar bank and feedback flywheel

Principles alone drift. The **exemplar bank** anchors them with labelled
examples — each exemplar carries a `type` (`true-positive`, `false-positive`,
`borderline`), a `category`, the `scenario`, the `verdict`, and the `principle`
it illustrates.

The flywheel: reviewers produce findings → the design lead accepts or dismisses
them → dismissed findings become `false-positive` exemplars and accepted ones
become `true-positive` exemplars → subsequent reviews are anchored to the
enlarged bank. `addExemplar()` is the write side of that loop.

Calibration is measured by the six design metrics (below); `usabilityFindingAccuracy`
is the flywheel's headline signal.

## Metrics and autonomy

Six metrics computed from state-store records feed autonomy promotion and
demotion — a design pipeline earns more autonomy only when its review layers
demonstrably work:

| Metric | Meaning |
|---|---|
| `designCiPassRate` | Design CI runs passing on first attempt |
| `usabilitySimulationPassRate` | Usability simulations completing successfully |
| `designReviewApprovalRate` | Reviews approved (any decision except rejected) |
| `designReviewFirstPassRate` | Reviews approved without a rejection cycle |
| `designCiAutoFixRate` | Design CI failures auto-fixed by the correction loop |
| `usabilityFindingAccuracy` | Finding precision — accepted / (accepted + dismissed) |

## Implementation status

This architecture is **partially implemented, and most of it is not yet
reachable**. The table below was verified against the source tree (barrel
exports and importers), not against the RFC text — adopters should be able to
trust it.

Three states are distinguished:

- **Wired** — implemented and reachable from a package's public surface.
- **Implemented, unwired** — the module exists in-tree with unit tests, but is
  not re-exported from any package barrel and has **no importers**. It is real
  code you can read and adapt, but `import { … } from '@ai-sdlc/…'` will not
  resolve it.
- **Spec-only** — described in RFC-0006 with no implementation.

| Surface | Status | Where |
|---|---|---|
| Token compliance / visual regression / story completeness gates | **Wired** | `QualityGate` rule types (`designTokenCompliance`, `visualRegression`, `storyCompleteness`) |
| `designReview` human gate | **Wired** | `QualityGate` rule type (RFC-0006 §8.5) |
| `UsabilitySimulationRunner` contract (Layer 3) | **Wired** (interface + stub; no production runner in v1alpha1) | `reference/src/adapters/interfaces.ts`, exported via `reference/src/adapters/index.ts` alongside `createStubUsabilitySimulationRunner` |
| Structural design preprocessor (Layer 2) | **Implemented, unwired** — `analyzeStructure`, `computeComplexityScore`, `triggersDesignReview`, full `StructuralDesignAnalysis` type tree | `reference/src/policy/structural-preprocessor.ts` |
| 7 design review principles + exemplar bank (Layer 4) | **Implemented, unwired** | `reference/src/policy/design-exemplar-bank.ts` |
| Six design metrics | **Implemented, unwired** | `orchestrator/src/design-system-metrics.ts` |
| Correction loop + review feedback pipeline | **Implemented, unwired** | `orchestrator/src/design-system-correction-loop.ts` |
| Design quality trend detector | **Implemented, unwired** | `orchestrator/src/design-quality-trend.ts` |
| Review / simulation persistence records | **Implemented** | `orchestrator/src/state/types.ts` |
| Design CI checks (Layer 1) — accessibility, touch targets, typography scale, spacing grid, colour palette, state completeness, `runDesignCI`, `generateDesignCIBoundary` | **Implemented, unwired** | `reference/src/policy/design-ci.ts` |
| An `accessibilityAudit` **QualityGate rule type** to invoke those checks from a pipeline gate | **Spec-only** — zero occurrences in the schema; the `checkAccessibility()` function above exists but nothing can call it declaratively. Run axe-core / Pa11y in your own CI meanwhile | RFC-0006 §A.3.1 |

### What "unwired" means for you

Six Addendum A modules — Design CI, the structural preprocessor, the exemplar
bank, the metrics, the correction loop, and the trend detector — are written and
unit tested but are not exported from `@ai-sdlc/reference` or
`@ai-sdlc/orchestrator` and are imported by nothing. Practically:

- The layered review **contract** is real and the code is there to read.
- The end-to-end flow is **not** running for you today; wiring is required
  before Layers 2 and 4 do anything in a live pipeline.
- Depending on these surfaces means importing by deep path into package
  internals, which is not a supported API and can change without notice.

Treat this section as the current truth rather than a roadmap promise: the RFC
describes the intended end state, and the gap above is what actually remains.

## See also

- [RFC-0006 Design System Governance Pipeline](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md) — the normative spec, Addendum A §A.1–A.10
- [Design System API reference](../api-reference/design-system.md) — resources, adapters, exemplar bank, metrics
- [Design System Operator Runbook](../operations/design-system-operator-runbook.md) — SLAs, events, triage
- [Getting Started with Design System Governance](../tutorials/design-system-getting-started.md)
- [Design Intent & Soul Alignment](../api-reference/design-intent.md) — the PPA Triad scoring layer that consumes design system outputs
