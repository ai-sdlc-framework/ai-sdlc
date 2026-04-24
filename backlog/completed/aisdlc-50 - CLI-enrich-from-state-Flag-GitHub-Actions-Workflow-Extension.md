---
id: AISDLC-50
title: CLI --enrich-from-state Flag + GitHub Actions Workflow Extension
status: Done
assignee: []
created_date: '2026-04-24 17:23'
updated_date: '2026-04-24 18:33'
labels:
  - cli
  - workflow
  - M3
milestone: m-1
dependencies:
  - AISDLC-49
references:
  - orchestrator/src/cli/
  - .github/workflows/ai-sdlc-admit.yml
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend admission CLI in `orchestrator/src/cli/` with new flags (§A.10):
- `--enrich-from-state` — load config, open state store, resolve refs, call `enrichAdmissionInput()` before scoring
- `--design-system-ref <name>` — explicit override
- `--autonomy-policy-ref <name>` — explicit override
- `--did-ref <name>` — explicit override

When `--enrich-from-state` absent: stateless mode with safe defaults (backward compat).

Emit `pillarBreakdown` in JSON output so the workflow comment body can render tension flags.

Update `.github/workflows/ai-sdlc-admit.yml` per §A.10 to pass `--author-association` and `--enrich-from-state` flags.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 CLI without flags produces same output as before (byte-stable)
- [x] #2 CLI with --enrich-from-state + fixture state DB produces enriched result
- [x] #3 Workflow is backward-compatible if .ai-sdlc/ directory absent (falls back to stateless)
- [x] #4 JSON output schema includes pillarBreakdown.tensionFlags[]
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Admission CLI and GitHub Actions workflow now support RFC-0008 enrichment end-to-end. Stateless mode is byte-stable with pre-RFC-0008 behaviour; adding `.ai-sdlc/` config (or the `--enrich-from-state` flag explicitly) opts in to C2/C3/C4/C5 enrichment. `pillarBreakdown` with tension flags flows through the JSON output and renders as a table in the issue comment.

## Changes
- `dogfood/src/cli-admit.ts`: added flags `--enrich-from-state`, `--design-system-ref <name>`, `--autonomy-policy-ref <name>`, `--did-ref <name>`, `--author-login <handle>`, `--code-area <path>`. When `--enrich-from-state` is set, loads `AiSdlcConfig`, opens the state store at `.ai-sdlc/state.db`, resolves the DSB/DID/AutonomyPolicy refs (named or first-instance default), and calls `enrichAdmissionInput()` before scoring. Gracefully degrades when the state DB is absent.
- `orchestrator/src/index.ts`: exported the RFC-0008 surface — `enrichAdmissionInput`, `computeDesignSystemReadiness`, `computeReadinessFromDesignSystemContext`, `computeDefectRiskFactor`, `computeAutonomyFactor`, `computeDesignAuthorityWeight`, `complexityToAutonomyLevel`, `EnrichmentContext`, `LifecyclePhase`, `computeAdmissionComposite`, `AdmissionComposite`, `computePillarBreakdown`, `detectTensions`, `pillarSignalScore`, and the supporting types (`PillarBreakdown`, `PillarContribution`, `PillarName`, `SharedDimensions`, `TensionFlag`, `TensionFlagType`, `HcChannelBreakdown`, `DesignSystemContext`, `AutonomyContext`, `CodeAreaQuality`, `DesignAuthoritySignal`, `DesignAuthoritySignalType`, `DesignQualityMetrics`).
- `.github/workflows/ai-sdlc-admit.yml`: new `Detect .ai-sdlc/ config presence` step sets the `--enrich-from-state` flag only when the config directory is populated — absent config falls back to stateless (AC #3). Author login plumbed through. Issue-admission comment now renders a "Pillar Breakdown" table + "Pillar Tensions" bullet list when tensions are present.
- `dogfood/src/cli-admit.test.ts` (new): 5 tests — stateless mode does not call enrichment (AC #1), enriched mode resolves refs (AC #2), graceful degradation when config is empty (AC #3), JSON output includes pillarBreakdown with tension array (AC #4), `--design-system-ref` overrides binding selection when multiple exist.

## Design decisions
- **Flag detection in workflow, not default-on**: the workflow explicitly probes for `.ai-sdlc/` presence and only passes `--enrich-from-state` when the directory has content. This keeps a repo that installed the framework but hasn't configured resources from hitting enrichment errors, and it makes the opt-in explicit in the workflow log.
- **State store path hard-coded to `.ai-sdlc/state.db`**: matches the orchestrator's convention. If the DB file is absent, the `StateStore.open` call fails and we set `stateStore: undefined` on the context — enrichment degrades to heuristic-only classification (no visual baselines, no code-area metrics) rather than erroring.
- **Resource selection prefers explicit ref, falls back to first instance**: `selectDsb/selectDid` accept an optional name and return the named entry if supplied, else the first. Matches the RFC expectation that single-tenant orgs won't name refs explicitly.
- **Enrichment context built with conditional spread**: `...(dsb ? { designSystemBinding: dsb } : {})` avoids sending `designSystemBinding: undefined`, which would override the type's absent case. Cleaner enrichment semantics downstream.
- **Workflow author-login piped via `github.event.issue.user.login`**: the existing `author_association` (trust tier) is kept; the new field is just the literal GitHub handle for C5 principal matching.

## Verification
- `pnpm build` (all 9 packages) — clean
- `pnpm vitest run src/cli-admit.test.ts` — 5/5 pass
- `pnpm test` (full workspace) — 3730/3730 pass, 3 pre-existing skips, no regressions
- `pnpm lint` — clean

## Follow-up
All of M3 (AISDLC-47–50) is done. Next up: M4 — reconciler + lookahead events (AISDLC-51 DesignIntentReconciler, -52 design-change.planned event, -53 DesignQualityTrendDegrading, -54 C7 design-lookahead notification). M4 is orthogonal to the hot admission path — it runs on scheduler ticks against existing state.
<!-- SECTION:FINAL_SUMMARY:END -->
