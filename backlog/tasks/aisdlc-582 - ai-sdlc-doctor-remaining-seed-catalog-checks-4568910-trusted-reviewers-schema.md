---
id: AISDLC-582
title: >-
  ai-sdlc doctor — remaining seed-catalog checks (4,5,6,8,9,10) +
  trusted-reviewers schema
status: To Do
assignee: []
created_date: '2026-09-05 22:38'
labels:
  - adoption
  - cli
  - doctor
  - config-validation
  - aisdlc-578-followup
dependencies: []
references:
  - >-
    backlog/completed/aisdlc-578 -
    ai-sdlc-doctor---end-to-end-project-config-health-audit-fix-workflow-recommendations.md
  - spec/rfcs/RFC-0045-adopter-health-upstream-reporting.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-578 shipped the `ai-sdlc doctor` check registry with a battle-tested priority subset of the 12-check seed catalog (checks 1 plugin-version, 2 runtime-deps-pins + caret-trap, 3 manifests-agree, 7 attestation-governance, 11 marketplace-catalog-drift, 12 npm-dist-tag-reachability), plus `--fix` for the mechanical subset and a shared branch-protection helper. Per the task's own explicit fallback clause ("land a coherent set... note any deferred check in the PR body"), the remaining checks were deferred to keep the first PR reviewable. This task finishes the catalog.

## Scope (remaining checks from the AISDLC-578 seed catalog)

Implement as new modules in the same `doctor-checks.ts` registry (documented extension point already exists):

- **Check 4** — `.ai-sdlc/agent-role.yaml` present + schema-valid against `spec/schemas/agent-role.schema.json` (surface what SessionStart swallows silently). Needs an ajv (or equivalent) JSON-schema validator dependency — the reason this group was deferred.
- **Check 5** — `.ai-sdlc/dor-config.yaml` present + schema-valid against `spec/schemas/dor-config.v1.schema.json` (only when the DoR feature is enabled).
- **Check 6** — `.ai-sdlc/trusted-reviewers.yaml` present + parseable + ≥1 pubkey; operator signing key (`~/.ai-sdlc/signing-key.pem`) present and its pubkey listed (when attestation enabled). **Add a `trusted-reviewers.schema.json` under `spec/schemas/`** (none exists yet) and wire check 6 to it.
- **Check 8** — husky pre-push gate wired (`.husky/pre-push` present + references the sign snippet).
- **Check 9** — feature-flag sanity (AI_SDLC_DEPS_COMPOSITION / AI_SDLC_AUTONOMOUS_ORCHESTRATOR default-ON expectations).
- **Check 10** — workflow-file presence for enabled features (diff against init-templates).

## Fold-in from AISDLC-578 review (security-reviewer completeness gap)

The `fetchBranchProtectionStatus` helper in `branch-protection-shared.ts` currently surfaces only `requiresPrReady` (+ approving-review + the attestation-direct misconfiguration). The AISDLC-388 contract requires BOTH `ai-sdlc/pr-ready` AND `Backlog Drift` as required contexts. Add a `requiresBacklogDrift` signal so the attestation-governance check (7) fully reflects the required-contexts contract. Read-only (no mutation) — a repo missing `Backlog Drift` should surface as a fail/warn, not be silently classified fully-configured.

## Reuse (do NOT reimplement)
- The existing `doctor-checks.ts` registry + `DoctorCheckAdapters` (exists/readFile/writeFile/listDir/homeDir/env/runCommand — runCommand now returns optional `stderr`).
- `spec/schemas/agent-role.schema.json` + `spec/schemas/dor-config.v1.schema.json` (validate with a real JSON-schema validator).
- The shared `branch-protection-shared.ts` helper for check 7's Backlog-Drift extension.

## Acceptance Criteria
- [ ] Checks 4, 5, 6, 8, 9, 10 implemented as registry modules with hermetic tests (known-good passes; each seeded misconfig detected with the right severity + remediation).
- [ ] `trusted-reviewers.schema.json` added under `spec/schemas/` and wired into check 6.
- [ ] JSON-schema validator dependency added (ajv or equivalent) and used by checks 4/5/6.
- [ ] `requiresBacklogDrift` signal added to `fetchBranchProtectionStatus`; check 7 flags a repo missing the `Backlog Drift` required context (read-only).
- [ ] `--fix` extended only where mechanically safe (e.g. add missing husky snippet); never touches `.ai-sdlc/**` content it shouldn't.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Follow-up to AISDLC-578 (merged via PR #1012). Local audit only — upstream reporting remains the separate RFC-0045 layer (do NOT build phone-home/telemetry here). Composes with the RFC-0045 reporting seam already stubbed in doctor's typed result set.
<!-- SECTION:DESCRIPTION:END -->
