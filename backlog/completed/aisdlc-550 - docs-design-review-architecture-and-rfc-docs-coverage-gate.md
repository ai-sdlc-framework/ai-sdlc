---
id: AISDLC-550
title: >-
  docs(design): document RFC-0006 Addendum A design review architecture +
  close the RFC-docs citation-vs-coverage gate that hid it
status: Done
assignee: []
labels:
  - docs
  - design-system
  - ci
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - scripts/check-rfc-docs.mjs
  - reference/src/policy/design-exemplar-bank.ts
  - orchestrator/src/design-system-metrics.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0006 Addendum A ("Deterministic-First Design Review Architecture", ~800
spec lines added 2026-04-02) is substantially implemented but has no
documentation. Operator search on 2026-07-29 found the code and no docs.

**Implemented, undocumented:**

- `reference/src/adapters/interfaces.ts` — `UsabilitySimulationRunner`
  (§A.5.2) with `PageState` / `BrowserSession` / `StoryEntry` supporting types
- `reference/src/policy/design-exemplar-bank.ts` — the exemplar bank (§A.6)
  including the **7 Design Review Principles** (`evidence-first`,
  `deterministic-first`, `context-awareness`, `severity-honesty`,
  `signal-over-noise`, `persona-grounding`, `scope-discipline`)
- `orchestrator/src/design-system-metrics.ts` — the six `DesignMetrics`
  (§13.2 / §A.10) feeding autonomy promotion/demotion
- `orchestrator/src/design-system-correction-loop.ts` — §8.4 correction loop
  and §8.5 design review feedback pipeline
- `orchestrator/src/state/types.ts` — `DesignReviewEventRecord`,
  `UsabilitySimulationResultRecord` persistence

**Root cause of the doc gap.** `scripts/check-rfc-docs.mjs` verifies that at
least one `.md` file under each mapped `docs/` subdirectory *contains the RFC
id* (`text.includes(rfcId)`). It is a **citation check, not a coverage
check**. RFC-0006's three doc surfaces were authored retroactively by
AISDLC-69.4 and satisfied the gate permanently; Addendum A landed afterwards
and there was no mechanism by which new spec sections could demand new docs.
The same hole applies to every RFC that grows after its docs are written.

**Scope of this task.** (1) Write the missing documentation, describing what
is actually implemented — including an honest implementation-status matrix,
because Layer 1 is only partly shipped (`designTokenCompliance`,
`visualRegression`, `designReview` gate rule types exist; there is no
`accessibilityAudit` rule type in the schema) and Layer 2 (structural design
preprocessor) has no implementation at all. Do not document spec-only
surfaces as if they ship. (2) Add an opt-in `docsCoverage` frontmatter list
to the RFC-docs linter: each declared term must appear in at least one doc
that cites the RFC, converting the citation check into a coverage check for
RFCs that declare it, and wire it on RFC-0006 so the new docs are pinned.

Broad `docsCoverage` adoption across the other ~40 RFCs is deliberately NOT
in scope — the convention is documented in `spec/rfcs/README.md` so new and
amended RFCs adopt it going forward.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A concepts page documents the four-layer design review architecture (Design CI → structural preprocessor → AI usability simulation → human design judgment), the Design CI boundary, the 7 principles, and the feedback flywheel
- [x] #2 The page carries an implementation-status matrix that accurately separates shipped / interface-only / spec-only surfaces (verified against code, not against the RFC)
- [x] #3 API reference documents the exemplar bank surface (`createExemplarBank`, `ExemplarBank`, `DesignExemplar`, `DESIGN_REVIEW_PRINCIPLES`) and the six `DesignMetrics` fields
- [x] #4 `check-rfc-docs.mjs` supports `docsCoverage: [terms]` — each term must appear in at least one RFC-citing doc; missing terms fail the gate with an actionable message; absent/empty field preserves current behaviour for all other RFCs
- [x] #5 RFC-0006 declares `docsCoverage` covering the Addendum A concepts, and `pnpm rfc:check` passes; removing the new docs makes it fail (regression-proven in tests)
- [x] #6 The `docsCoverage` convention is documented in `spec/rfcs/README.md`
- [x] #7 `pnpm rfc:test`, `pnpm docs:check`, `pnpm lint`, `pnpm format:check` all pass
<!-- AC:END -->
