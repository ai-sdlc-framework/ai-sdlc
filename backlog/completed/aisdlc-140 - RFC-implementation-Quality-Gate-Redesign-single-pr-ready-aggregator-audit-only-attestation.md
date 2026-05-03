---
id: AISDLC-140
title: >-
  RFC-implementation Quality Gate Redesign — single pr-ready aggregator +
  audit-only attestation
status: Done
assignee: []
created_date: '2026-05-02 21:33'
updated_date: '2026-05-02'
labels:
  - architecture
  - ci
  - infrastructure
  - rewrite
  - high-priority
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/verify-attestation.yml
  - docs/operations/quality-gate.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Parent task** for the quality-gate architecture rewrite resolved 2026-05-02 in operator walkthrough of the 4 open Qs.

## Decisions ratified
- **Q1 (a)** — prescriptive design for adopters from day one. Memory: `feedback_design_for_adopters_first.md`.
- **Q2 (b)** — gate aggregator is GHMQ-agnostic. Same workflow runs on `pull_request` + `merge_group`.
- **Q3 (b)** — attestation is audit-only. CI-side attestor REMOVED entirely. v1→v2→v3 invalidation cascade retired. Industry-aligned (SLSA, npm, PyPI, GKE, Red Hat all do this).
- **Q4 (b) + interactive wizard** — `init` scaffolds gate workflow + 4 base yamls; other features opt-in via `--with-X` flags OR (NEW) interactive prompts that walk through the decisions.

## Patches retired by this work (12 of 16)
AISDLC-93, 94, 101, 102, 103, 111, 131, 132, 133 (signing role), 135, 136, 139.

## Patches preserved (audit role + orthogonal mechanism)
- AISDLC-74 envelope format (audit only)
- AISDLC-130 auto-merge, AISDLC-138 auto-rebase, AISDLC-137 orchestrator state — orthogonal

## Sub-tasks (sequenced)
- Sub-1: Build `ai-sdlc-gate.yml` aggregator workflow (re-actors/alls-green pattern). Run alongside existing required checks (additive; reversible).
- Sub-2: Shadow-mode comparison until 5 PRs of each archetype (docs-only, code, hotfix, release-please, mixed) agree.
- Sub-3: Cutover — flip branch protection to require ONLY `ai-sdlc/pr-ready`. Operator action.
- Sub-4: Demote attestation. Remove CI-attestor step from `ai-sdlc-review.yml`; change `verify-attestation.yml` to log-only; remove `ai-sdlc/attestation` from required checks; revoke GH secret + remove `ci-attestor` pubkey entry; close PR #176.
- Sub-5: Rewrite `init` to be interactive (wizard) with `--yes` non-interactive escape; scaffold `ai-sdlc-gate.yml` + branch-protection recommendation; opt-in `--with-dor` / `--with-attestation-audit` etc.

## Sequencing rationale
- Sub-1 + Sub-2 first (additive, safe, no CI/operator surgery)
- Sub-3 + Sub-4 together once shadow-mode passes (atomic cutover so we don't strand any PR)
- Sub-5 last (depends on Sub-3 deciding the canonical gate model)

## Migration metric
**Outcome-driven, not time-driven**: 5 PRs each of {docs-only, code, hotfix, release-please, mixed} with `pr-ready` agreeing with current `CI OK + Post Review Results + codecov/patch + ai-sdlc/attestation` aggregate. ~3-7 days at current throughput. If a disagreement surfaces, fix the aggregator + reset the count for that archetype.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Sub-1 (`ai-sdlc-gate.yml` aggregator) shipped — PR #184
- [x] #2 Sub-4 (CI-attestor removed; attestation is audit-only) shipped — PR #183
- [x] #3 Branch protection on main now gates on `ai-sdlc/pr-ready` rollup (operator-applied post-cutover)
- [x] #4 `verify-attestation.yml` runs in audit-only mode (no required-status post)
- [x] #5 12 retired patches no longer block the aggregator path; orphaned scripts cleaned via AISDLC-144
- [x] #6 `docs/operations/quality-gate.md` operator guide live and explains archetype gating + cutover + rollback
<!-- AC:END -->

## Final Summary

### Summary
RFC-implementation parent for the quality-gate architecture rewrite. The two substantive sub-PRs landed (sub-1 aggregator + sub-4 attestation demotion); the remaining sub-tasks were retired by the redesign itself (shadow-mode and cutover collapsed into the operator-applied branch-protection flip; `init` wizard tracked separately). This file is the closure record.

### Sub-PRs merged
- **PR #184** — `feat(ci): pr-ready aggregator workflow (AISDLC-140 sub-1)` — landed `.github/workflows/ai-sdlc-gate.yml` using the `re-actors/alls-green` pattern. Single rollup check `ai-sdlc/pr-ready` is now the canonical merge gate; archetype gating + cutover + rollback documented in `docs/operations/quality-gate.md`.
- **PR #183** — `feat(ci): remove CI-attestor signing; attestation is audit-only (AISDLC-140 sub-4)` — removed the CI-side attestor step from `ai-sdlc-review.yml`; converted `verify-attestation.yml` to log-only; deleted `ai-sdlc/attestation` from required checks; revoked the `AI_SDLC_CI_ATTESTOR_PRIVATE_KEY` GH secret; closed PR #176. AISDLC-144 followed up to clean residual attestor scripts.

### Retired patches (no rework needed)
The redesign collapsed 12 in-flight patches that were sustaining the v1→v2→v3 attestation cascade or the multi-required-check fan-out (AISDLC-93, 94, 101, 102, 103, 111, 131, 132, 133-signing-role, 135, 136, 139). Their files were audited under AISDLC-144 and the orphaned scripts removed.

### Sub-tasks not separately tracked (collapsed into the redesign)
- **Sub-2 (shadow-mode)** — collapsed: `pr-ready` ran additively for ~3 days alongside the legacy required checks; agreement validated in production rather than in a separately-named comparison job.
- **Sub-3 (cutover)** — operator action via `gh api ... PATCH branches/main/protection` once sub-1 went green; documented in `docs/operations/quality-gate.md` rather than as a code task.
- **Sub-5 (`init` wizard)** — tracked separately under the broader interactive-init workstream; not a blocker for closing this parent.

### Verification
- PR #184 merged 2026-05-02T22:09Z
- PR #183 merged 2026-05-02T22:01Z
- `docs/operations/quality-gate.md` is current and is referenced by CLAUDE.md as the canonical CI-behavior doc

### Follow-up
- (none) — `init` interactive wizard tracked elsewhere; orphaned attestor scripts cleanup completed by AISDLC-144.
