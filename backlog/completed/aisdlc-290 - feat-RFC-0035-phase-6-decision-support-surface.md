---
id: AISDLC-290
title: 'feat: RFC-0035 Phase 6 — Decision support surface (recommendation + counter-argument + sub-decision graph)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-15'
updated_date: '2026-05-24'
labels:
  - rfc-0035
  - decision-catalog
  - phase-6
  - critical-path
dependencies:
  - AISDLC-288
  - AISDLC-289
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
blocked:
  reason: 'RFC-0035 14/14 OQs resolved per 2026-05-15 walkthrough; lifecycle is Ready for Review awaiting per-owner sign-off. Phase 6 implementation proceeds under operator-acknowledged upstream-OQ override — same pattern as sibling Phase 4 (AISDLC-288) and Phase 5 (AISDLC-289).'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0035 Implementation Plan (§14). Renders the decision support surface so operators get the full problem / options / recommendation / counter-argument bundle the AskUserQuestion walkthrough format produces manually.

## Scope

- Per-decision rendering: problem, options, recommendation, confidence, counter-argument
- Sub-decision graph rendered as Mermaid-style text tree
- Integrates with `cli-decisions show <id>`
- Stage A / B / C verdict provenance visible inline
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Per-decision rendering shows problem, options, recommendation, confidence, counter-argument
- [x] #2 Sub-decision graph rendered as Mermaid-style text tree
- [x] #3 Integrates with `cli-decisions show <id>` command
- [x] #4 Stage A/B/C verdict provenance visible (which tier resolved it, with what signals)
- [x] #5 Backward-compatible: decisions without sub-decisions render without empty tree section
<!-- AC:END -->

## Implementation Notes

New module `pipeline-cli/src/decisions/decision-support-surface.ts` exposes:

- `buildDecisionSupportView(decision)` — pure projection of a `Decision` into a structured `DecisionSupportView`. Pre-computes the recommendation status (`auto-applied` vs `pending-operator`), Stage A/B/C provenance blocks (each gated on the corresponding `status.evaluation.stageX` being present per AC#5), and the sub-decision graph forest (union of declared `spec.options[].subDecisions` and Stage C `subDecisionsImplied`).
- `renderDecisionSupportSurface(view)` — Markdown-compatible text renderer with sections suppressed when their underlying data is absent (AC#5). Output composes Mermaid `flowchart TD` graph fences with an indented text-outline fallback so TUI consumers without a Mermaid renderer still see the structure.
- `renderSubDecisionGraphMermaid(graph, decisionId)` — returns `null` when no option carries sub-decisions (backward-compat); otherwise emits a `flowchart TD` with the decision as root, each option-with-sub-decisions as a child, and the sub-decisions as leaves. Stage C-implied sub-decisions get a `? ` prefix; option labels are `&quot;`-escaped per Mermaid's quoting rules.
- `renderStageProvenance(view)` — emits one `### Stage X` block per tier that has provenance. Stage B `sub-actors` line surfaces only when multi-pillar routing populated `subActors[]`; Stage C `error` and `auto-applied at` lines surface only when populated.

`cli-decisions show <id>` now:

- Text mode: prints the existing audit-style header + event history, followed by the Phase 6 surface (`renderShowWithSupportSurface()`).
- Text mode with `--support-surface-only`: skips the audit header + event history; emits ONLY the Phase 6 surface (digest-friendly).
- JSON mode: always includes the structured `supportSurface` view alongside the raw `decision`.

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 5180 passed, 1 skipped (273 test files)
  - new: `decision-support-surface.test.ts` (21 tests) + 6 new CLI integration tests in `cli/decisions.test.ts`
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Coverage (pipeline-cli package): 91.53% lines; new `decision-support-surface.ts` at 100% lines / 100% funcs / 98.79% branches
