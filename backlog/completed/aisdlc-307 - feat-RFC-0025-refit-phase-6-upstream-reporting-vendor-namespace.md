---
id: AISDLC-307
title: 'feat: RFC-0025 Refit Phase 6 — Upstream reporting + vendor-namespace enforcement (OQ-5 + OQ-10)'
status: Done
assignee: []
created_date: '2026-05-16'
completed_date: '2026-05-20'
labels:
  - rfc-0025
  - refit
  - phase-6
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 6. Implements the OQ-5-affirmed operator-initiated pre-filled GitHub issue and the OQ-10-affirmed strict vendor-namespace enforcement.

## Scope (OQ-5 upstream reporting — operator-initiated, no telemetry pipeline)

- `cli-quality report-upstream <bug-id>` command + TUI prompt surface.
- Pre-generates an issue body (anonymized repro, classifier output, suggested fix, related code paths).
- Opens browser to the framework repo's `issues/new` URL with the body query parameter pre-filled (per-org `repoUrl` resolves the host).
- Per-org `repoUrl` configurable in `quality-monitoring.yaml`.
- `.ai-sdlc/templates/framework-bug-report.md` template that the operator can customize.
- Industry parallel: `bun --report-bug`, VS Code Report Issue, Rust panic handler.

## Scope (OQ-10 vendor namespace)

- Schema validation rejects un-namespaced custom subclasses on resource load.
- Vendor reverse-DNS prefix required (e.g., `acme.com/security-policy-violation`).
- Clear error message at load time; matches k8s CRD / npm scoped / Go module convention.
- `quality.vendor-namespace.enforce: reject` (default; `warn` and `none` available but deprecated).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `cli-quality report-upstream <bug-id>` command ships
- [x] #2 TUI prompt surface for the same flow
- [x] #3 Pre-generated issue body includes anonymized repro + classifier output + suggested fix + related code paths
- [x] #4 Browser opens to GitHub new-issue URL with body pre-filled
- [x] #5 `.ai-sdlc/templates/framework-bug-report.md` shipped + customizable
- [x] #6 Schema validation rejects un-namespaced custom subclasses on resource load
- [x] #7 Clear error message at load time
- [x] #8 RFC-0025 lifecycle flipped Ready for Review → Implemented after this phase ships
<!-- AC:END -->

## Final Summary

### What shipped

**OQ-5 — operator-initiated upstream reporting (no telemetry pipeline)**

- New CLI `cli-quality report-upstream <bug-id>` (`pipeline-cli/bin/cli-quality.mjs` → `pipeline-cli/src/cli/quality.ts`). Resolves `repoUrl` from `--repo-url` flag → `quality.upstream-reporting.repoUrl` in `quality-monitoring.yaml` → hard error.
- New `pipeline-cli/src/tui/analytics/upstream-reporter.ts` module:
  - `loadCaptureRecord(bugId)` reads `$ARTIFACTS_DIR/_quality/captures.jsonl` by id (full or short form).
  - `anonymiseText()` strips macOS/Linux home paths, worktree paths, OpenAI / GitHub / Slack token shapes, and email addresses.
  - `renderIssueBody()` interpolates a customisable template (default `.ai-sdlc/templates/framework-bug-report.md`); falls back to `BUILTIN_UPSTREAM_TEMPLATE` for fresh worktrees.
  - `suggestFixForSubclass()` + `relatedPathsForSubclass()` add subclass-specific heuristics for the seven built-in `framework-misbehaved` subclasses.
  - `buildUpstreamReport()` produces the `<repoUrl>/issues/new?title=…&body=…` URL.
  - `openInBrowser()` dispatches `open` / `xdg-open` / `cmd start` via a detached child process; spawnable through an injection point for tests.
- New template at `.ai-sdlc/templates/framework-bug-report.md` — operator-customisable; surfaces severity, anonymised repro, suggested fix, related code paths, operator checklist.

**OQ-10 — strict vendor-namespace enforcement at resource-load time**

- Extended `pipeline-cli/src/tui/analytics/quality-monitoring-config.ts` with `upstreamReporting`, `vendorNamespace`, and `customSubclasses` config blocks per §13.1.
- New `enforceVendorNamespaceConfig()` runs `validateVendorNamespace()` over every entry in `customSubclasses`:
  - `vendorNamespace.enforce: reject` (default) — throws `QualityMonitoringConfigError` with a clear actionable message listing every violator and the fix.
  - `vendorNamespace.enforce: warn` — logs each violation to the provided logger; load succeeds.
  - `vendorNamespace.enforce: none` — skips the check entirely.
- `loadQualityMonitoringConfig()` invokes enforcement after parsing; the throw lands at the resource-load boundary so adopters cannot accept an illegal config silently.

**RFC-0025 lifecycle**

- Flipped `lifecycle: Ready for Review` → `lifecycle: Implemented` (and `status: Implemented`) in `spec/rfcs/RFC-0025-framework-quality-monitoring.md` frontmatter + bold-status block.
- Updated §13 implementation-status callout to describe what shipped across Phases 1/3/6 and what remains in Phases 2/4/5 (AISDLC-303/305/306).
- Added v0.3 revision-history entry.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean.
- 72 new + extended unit tests pass:
  - `pipeline-cli/src/tui/analytics/upstream-reporter.test.ts` — 34 tests (capture lookup, anonymisation, template rendering, URL builder, browser-open injection).
  - `pipeline-cli/src/cli/quality.test.ts` — 7 tests (config fallback resolution, CLI arg precedence, error paths).
  - `pipeline-cli/src/tui/analytics/quality-monitoring-config.test.ts` — 31 tests (existing 21 plus 10 new Phase 6 tests covering upstream-reporting parse, vendor-namespace parse, customSubclasses parse, enforcement modes, load-time rejection).

### Design decisions

- **Non-flaky test files** — chose `.test.ts` (not `.flaky.test.ts`) for both new test files because they use the same `tmpdir + fs` pattern as `quality-monitoring-config.test.ts` (already non-flaky). The AISDLC-375 flake symptom is a coverage-job hang specific to the original quality-* sources; the new modules are not subject to it.
- **DEFAULT_UPSTREAM_TEMPLATE_PATH ownership** — defined in `quality-monitoring-config.ts` and re-exported from `upstream-reporter.ts` so the config-schema source-of-truth and the renderer share one constant.
- **Anonymisation conservatism** — strips obvious secret shapes + home paths + email addresses; deliberately does NOT attempt to redact arbitrary identifiers that could be operationally relevant signal for maintainers.
- **Browser-open is best-effort + injectable** — `openInBrowser()` accepts a `spawnFn` override so tests never actually shell out, and CLI text-mode always prints the URL so copy-paste works when `open` is unavailable.

### Follow-up

- AISDLC-303 (Phase 2 — confidence-bucketed classifier per OQ-1).
- AISDLC-305 (Phase 4 — suggest-only attribution per OQ-4 + full §13.1 severity-weights / classifier-thresholds config).
- AISDLC-306 (Phase 5 — coverage-gap auto-quarantine per OQ-6 + composite blast-radius determinism sampling per OQ-7 + operator-time-cost instrumentation per OQ-9).
- `customSubclasses` are accepted at config-load time but not yet referenced anywhere else; Phase 4 wires them into the classifier's `subclassHint` validation pathway so adopter subclasses participate in the full classification flow.
