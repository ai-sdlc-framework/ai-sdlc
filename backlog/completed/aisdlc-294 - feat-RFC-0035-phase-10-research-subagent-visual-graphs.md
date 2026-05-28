---
id: AISDLC-294
title: 'feat: RFC-0035 Phase 10 — Research subagent integration + visual decision graphs'
status: Done
assignee: []
created_date: '2026-05-15'
completed_date: '2026-05-27'
labels:
  - rfc-0035
  - decision-catalog
  - phase-10
dependencies:
  - AISDLC-290
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 10 of RFC-0035 Implementation Plan (§14). Optional enhancements: research subagent for low-confidence Stage C signals; richer decision graph rendering; NotebookLM-style summaries.

## Scope

- Research subagent invocation for unfamiliar decision domains (low-confidence Stage C signal)
- Visual decision graph renderer (Mermaid → richer HTML)
- NotebookLM-style summary generation (optional, behind feature flag)
- Documented adopter integration path
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Research subagent invocation gated on Stage C confidence < threshold (configurable)
- [x] #2 Visual decision graph renderer (Mermaid + downstream HTML)
- [x] #3 NotebookLM-style summary generation (optional, behind feature flag)
- [x] #4 Documented adopter integration path (init scaffold template)
- [x] #5 Subagent call cost capped via SubscriptionLedger integration (RFC-0010)
<!-- AC:END -->

## finalSummary

### Summary
RFC-0035 Phase 10 ships the optional decision-support augmentations: a research-subagent invoker contract gated on a configurable confidence floor (`researchSubagentConfidenceThreshold`, default 0.6), a richer HTML/Mermaid graph renderer surfaced via `cli-decisions graph`, a feature-flag-gated NotebookLM-style summary runner, and the adopter scaffold + integration runbook. All four LLM-call surfaces (Stage C, research, summary; via the shared substrate) honor the RFC-0010 SubscriptionLedger writer for per-call cost accounting.

### Changes
- `pipeline-cli/src/decisions/research-subagent.ts` (new): confidence gate (`shouldInvokeResearchSubagent`), invoker contract (`ResearchSubagentInvoker`), sidecar persistence (`writeResearchArtifact`/`readResearchArtifacts`), runner (`runResearchSubagent`). Findings persist to `.ai-sdlc/_decisions/research/<DEC>-<ISO>.md` to avoid expanding the event-type enum (OQ-1 additive-only constraint).
- `pipeline-cli/src/decisions/notebook-summary.ts` (new): feature-flag predicate (`AI_SDLC_DECISION_NOTEBOOK_SUMMARIES`), invoker contract (`NotebookSummaryInvoker`), runner (`runNotebookSummary`). Single-file persistence at `.ai-sdlc/_decisions/summaries/<DEC>.md`.
- `pipeline-cli/src/decisions/decision-support-surface.ts`: added `renderSubDecisionGraphHtml()` — standalone HTML page with embedded Mermaid CDN renderer; defends against `</script>` injection via HTML escaping.
- `pipeline-cli/src/decisions/decisions-config.ts`: added `researchSubagentConfidenceThreshold` field (Phase 10 config knob).
- `pipeline-cli/src/decisions/index.ts`: re-exports the two new modules.
- `pipeline-cli/src/cli/decisions.ts`: three new subcommands — `graph <id> --format mermaid|html|json`, `research <id> [--gate]` (read-only; no transport baked in), `summary <id>`.
- `.ai-sdlc/templates/decisions-config.yaml` (new): canonical adopter scaffold with all Phase 1-10 config knobs documented.
- `docs/operations/decision-catalog-phase10-adopter-integration.md` (new): wiring runbook showing how adopters inject the invoker, mount the ledger writer, and consume the read-only CLI surfaces.
- Tests: 57 new units (`research-subagent.test.ts`, `notebook-summary.test.ts`, expanded `decision-support-surface.test.ts`) + 13 new CLI subcommand tests covering empty/JSON/error/disabled-flag paths.

### Design decisions
- **Sidecar persistence over new DecisionEvent type**: Research findings land in `.ai-sdlc/_decisions/research/<DEC>-<ISO>.md` rather than as `research-completed` events. Honors OQ-1's additive-only event-type constraint and avoids forcing every projector to handle a new event class. Findings are an on-demand augmentation (RFC §8.2), not a state-altering lifecycle event.
- **Invoker injection over baked-in transport**: Both `runResearchSubagent` and `runNotebookSummary` accept a `*Invoker` function the caller wires. Mirrors the classifier substrate's existing pattern — adopters wire their preferred Claude Code subagent / `claude -p` shellout / Codex bridge / etc. The `cli-decisions research|summary` subcommands are READ-ONLY; no transport in the CLI means no monkey-patching across adopters.
- **Confidence floor strictly < Stage C threshold**: Default `0.6` is set strictly below Stage C's `0.7` auto-apply threshold so the "low-confidence / research" band lives strictly below the "auto-apply" band. Documented in both the config template and the threshold's JSDoc.
- **NotebookLM OFF by default**: extra LLM call per decision; not load-bearing for v1 operation. Adopters explicitly turn on `AI_SDLC_DECISION_NOTEBOOK_SUMMARIES`.
- **Mermaid HTML uses CDN**: One script tag, operator-side surface (not subagent sandbox), no offline-mode requirement for v1. Future work may bundle `mermaid.min.js` for offline use.

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 5731/5731 passing
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Full repo `pnpm test` — passes, with one pre-existing flaky `useBacklogTasks > clears the polling timer on unmount` (unrelated; documented in `memory:feedback_flaky_events_tail_test`; passes in isolation)

### Follow-up
- (none — Phase 10 was scoped as optional augmentation; Phase 11 promotion runbook ships separately as AISDLC-295)
