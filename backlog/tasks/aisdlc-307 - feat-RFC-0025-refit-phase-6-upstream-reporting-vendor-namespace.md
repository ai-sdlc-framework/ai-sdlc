---
id: AISDLC-307
title: 'feat: RFC-0025 Refit Phase 6 — Upstream reporting + vendor-namespace enforcement (OQ-5 + OQ-10)'
status: To Do
assignee: []
created_date: '2026-05-16'
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
- Opens browser to `https://github.com/<framework-repo>/issues/new?body=<pre-filled>`.
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
- [ ] #1 `cli-quality report-upstream <bug-id>` command ships
- [ ] #2 TUI prompt surface for the same flow
- [ ] #3 Pre-generated issue body includes anonymized repro + classifier output + suggested fix + related code paths
- [ ] #4 Browser opens to GitHub new-issue URL with body pre-filled
- [ ] #5 `.ai-sdlc/templates/framework-bug-report.md` shipped + customizable
- [ ] #6 Schema validation rejects un-namespaced custom subclasses on resource load
- [ ] #7 Clear error message at load time
- [ ] #8 RFC-0025 lifecycle flipped Ready for Review → Implemented after this phase ships
<!-- AC:END -->
