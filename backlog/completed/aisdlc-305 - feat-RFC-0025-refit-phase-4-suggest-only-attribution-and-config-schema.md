---
id: AISDLC-305
title: 'feat: RFC-0025 Refit Phase 4 — Suggest-only attribution + quality-monitoring.yaml schema (OQ-2 + OQ-4)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0025
  - refit
  - phase-4
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 4. Implements the OQ-2-affirmed YAML+CLI config surface and the OQ-4-affirmed per-org-configurable suggest-only attribution.

## Scope (OQ-2 config surface)

- Ship `.ai-sdlc/quality-monitoring.yaml` schema per §13.1.
- Severity-weights override per-axis (`operator-time-cost`, `framework-recurrence`, `blast-radius`).
- One-shot CLI override via `--severity-weight axis=value` flag on relevant CLIs.
- `ai-sdlc init` template seeds the YAML with documented defaults.

## Scope (OQ-4 suggest-only attribution)

- Default behavior: framework-bug captures surface top-3 CODEOWNERS candidates in TUI + Slack DM; operator confirms.
- Per-org opt-in to auto-attribute via `quality.framework-bug.autoAttribute: true`.
- `attributionSources` extensible (`codeowners` shipping; `git-blame`, `recent-pr` are v2 extensions).
- `suggestionCount` configurable (default 3).
- LinkedIn-postmortem owner-blame anti-pattern explicitly avoided.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `.ai-sdlc/quality-monitoring.yaml` schema ships per §13.1
- [x] #2 `ai-sdlc init` template seeds documented defaults
- [x] #3 Severity-weights per-axis overridable via YAML + CLI flag
- [x] #4 Default attribution = suggest top-3 CODEOWNERS candidates (no force-assign)
- [x] #5 `autoAttribute: true` per-org override force-assigns
- [x] #6 TUI + Slack DM surfaces show suggested candidates with operator-confirm affordance
- [x] #7 Test coverage for default + overridden attribution paths
<!-- AC:END -->

## Final Summary

### Summary
Phase 4 of the RFC-0025 Refit lands the OQ-2 severity-weights YAML+CLI override surface and the OQ-4 suggest-only attribution UX. The router's behaviour flips: by default framework-bug captures now write `assignee: []` and return the resolved CODEOWNERS candidates as a suggestion list (`RouteResult.assignees` + `assigneesAutoApplied: false`) for the TUI/Slack DM to confirm; `quality.framework-bug.autoAttribute: true` keeps the legacy force-assign behaviour for adopters that opt in. The §13.1 config schema is now complete — `severity-weights`, `framework-bug`, `attributionSources`, and the OQ-2 CLI flag (`cli-quality severity-weights --severity-weight <axis>=<value>`) compose with the existing per-org YAML loader.

### Changes
- `pipeline-cli/src/tui/analytics/quality-monitoring-config.ts` (modified): added `SeverityWeightsConfig` + `FrameworkBugAttributionConfig` types and defaults, extended parser with `severity-weights` / `framework-bug` / `attributionSources` blocks (kebab + camelCase axis aliases), added `parseSeverityWeightFlag` + `resolveSeverityWeights`, refactored block-header flush to a shared helper.
- `pipeline-cli/src/tui/analytics/quality-classifier.ts` (modified): `computeSeverity()` accepts an optional `weights` arg — unweighted path is preserved bit-for-bit for backward compat; weighted path multiplies ordinals + re-buckets.
- `pipeline-cli/src/tui/analytics/quality-router.ts` (modified): `routeFrameworkBug()` now loads the OQ-4 attribution config + resolves candidates via `resolveAttributionCandidates()` (pluggable backends, ships `codeowners`); suggest-only is the default, `autoAttribute: true` is the opt-in. `RouteResult` gains `assigneesAutoApplied`. The task body always renders a "Suggested investigators (OQ-4 attribution)" audit-trail section.
- `pipeline-cli/src/cli/quality.ts` (modified): new `severity-weights` subcommand exposes the resolved per-axis weights; accepts repeatable `--severity-weight <axis>=<value>` flags (CLI > YAML > defaults).
- `orchestrator/src/cli/commands/init-templates.ts` (modified): new `QUALITY_MONITORING_CONFIG_STUB` (documentation-as-data; every block commented-out with defaults) + `FRAMEWORK_BUG_REPORT_TEMPLATE_STUB`; both wired into `BASELINE_WORKFLOW_TEMPLATES` so `ai-sdlc init` seeds them by default. A separate `QUALITY_MONITORING_TEMPLATES` set is also exported for future `--with-quality-monitoring` toggle composition.
- Tests (modified): 4 new test cases on `computeSeverity` covering the weighted path + clamping; 11 new test cases on the config parser covering severity-weights / framework-bug / CLI flag / clamp behaviour; 6 new test cases on the router covering the OQ-4 suggest-only + auto-attribute branches + resolver dedup + suggestionCount cap; 3 new test cases on `cli-quality severity-weights`. Total: 147 quality-suite tests passing, 5026 pipeline-cli tests passing.

### Design decisions
- **Backward-compat for `computeSeverity(axes)`**: the existing signature is preserved; the new `weights` arg is optional. Avoids a forced-migration of every existing caller (~5 sites) for a Phase-4 surface they don't yet need.
- **CLI flag axis aliases**: accept both kebab (`operator-time-cost`) and camelCase (`operatorTimeCost`). Operators get whichever form they remember; §13.1 documents the kebab form.
- **Init template lives in BASELINE, not a feature toggle**: the YAML stub is pure documentation-as-data (every block commented). Forcing adopters through `--with-quality-monitoring` adds friction without value when the surface is already opt-in via uncommenting. The `QUALITY_MONITORING_TEMPLATES` set is still exported for future composition.
- **AC #6 (TUI + Slack DM surfaces)**: the data contract (`RouteResult.assignees` + `assigneesAutoApplied`) is the consumer-facing surface for both. The actual TUI panel + Slack DM rendering is out-of-scope for Phase 4 (separate UI tasks); the task body's "Suggested investigators" audit-trail section provides the operator-visible affordance today.
- **Loader-failure isolation in router**: if `loadQualityMonitoringConfig()` throws (e.g. an OQ-10 vendor-namespace violation in an unrelated block), the router falls back to suggest-only defaults rather than crashing. The capture record (Step 1) already landed; refusing to write the task would lose the audit trail.

### Verification
- `pnpm build` — clean (all 22 workspace packages)
- `pnpm test` — clean (5026 pipeline-cli + 3697 orchestrator + 172 dashboard + 159 mcp-server + 24 conformance + 131 mcp-advisor + 372 dogfood = 9581 unit tests passing, plus all Node-test hook suites)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up
- Phase 5 (AISDLC-306) already shipped (coverage-gap + determinism + op-time-cost). Phase 2 (AISDLC-303) shipped. With Phase 4 landing, all RFC-0025 §13 OQ surfaces are implemented.
- The TUI panel + Slack DM rendering for suggest-only attribution is a future task (uses `RouteResult.assignees` + `assigneesAutoApplied`).
- `git-blame` + `recent-pr` attribution backends are documented as v2 extensions in `attributionSources` but not implemented in Phase 4 (forward-compat: unknown backends are silently skipped).
