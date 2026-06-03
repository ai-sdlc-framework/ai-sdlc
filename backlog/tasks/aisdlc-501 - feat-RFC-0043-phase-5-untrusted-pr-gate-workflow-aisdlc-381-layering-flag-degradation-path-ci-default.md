---
id: AISDLC-501
title: 'feat: RFC-0043 Phase 5 — untrusted-pr-gate.yml workflow + AISDLC-381 layering + AI_SDLC_UNTRUSTED_PR_GATE flag + degradation path + CI default deployment mode'
status: To Do
assignee: []
created_date: '2026-06-02'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - phase-5
  - ci-workflow
  - feature-flag
dependencies:
  - AISDLC-497
  - AISDLC-498
  - AISDLC-499
  - AISDLC-500
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0043. Wires the 4-stage pipeline into a single CI workflow + adopter feature flag + graceful degradation when OpenShell unavailable. Implements OQ-2's CI-default deployment mode.

## Scope (RFC-0043 §Migration Path + OQ-2 resolution)

### `.github/workflows/untrusted-pr-gate.yml`

- Triggers on `pull_request_target` (per AISDLC-381 fork-PR hardening pattern)
- Layers on existing AISDLC-381 sandboxed `pr-content/` checkout + `persist-credentials: false`
- 4-stage orchestration: Stage 0 trust classifier → Stage 1 AST gate → Stage 2/3 sandbox (Phase 3) → Stage 4 clean-room signer (Phase 2)
- Composes with `ai-sdlc/pr-ready` rollup check (does NOT replace; adds untrusted-PR gate as additional required check)

### OQ-2 — CI default deployment mode

- `.ai-sdlc/untrusted-pr-gate.yaml: deployment: ci` (default for untrusted PRs)
- `deployment: local` opt-in for solo maintainers / small teams without CI sponsorship
- CI runs reviewers (Phase 4) inside CI-side OpenShell sandbox (Phase 3)
- Local opt-in path runs reviewers inside local OpenShell sandbox on maintainer machine

### Feature flag

- `AI_SDLC_UNTRUSTED_PR_GATE` (default `off`)
- Truthy values: `1`, `true`, `yes`, `on` (case-insensitive); anything else (including unset) is OFF
- When OFF: UCVG path not engaged; existing review path runs as before
- When ON: UCVG engages for all PRs classified as untrusted (per Stage 0)
- Follows RFC-0014 / RFC-0015 opt-in → default-on promotion pattern

### Degradation path

When OpenShell unavailable in CI runner OR `deployment: local` set + maintainer has no OpenShell installed:

- Stage 0 + Stage 1 (deterministic, no LLM) STILL run — these are the highest-value cheap defenses
- Stage 3 reviewers run in degraded mode: static-diff review only (no differential testing); reviewers run with existing credential model (not sandbox-isolated)
- Stage 4 clean-room signer STILL runs (signs whatever report was emitted)
- Clear operator message: "Stage 2 unavailable; falling back to static-review-only + hard AST gate"
- `Decision: untrusted-pr-gate-degraded-mode` emitted via RFC-0035 G0 catalog (operator awareness)

### Hermetic tests

- Workflow YAML validates against GitHub Actions schema
- 4-stage orchestration: each stage's failure propagates correctly; pipeline halts at first abort
- Feature flag honored: OFF → UCVG path skipped; ON → engaged for untrusted PRs
- CI-default deployment mode: workflow runs reviewers in CI sandbox
- Local opt-in path: workflow detects `deployment: local`, hands off to maintainer's local pipeline
- Degradation path: missing OpenShell → degraded mode, Stage 0/1 still run, Decision emitted

## Composes with

- AISDLC-497, 498, 499, 500 (Phases 1-4): orchestrates the full 4-stage pipeline
- AISDLC-381 (fork-PR CI hardening): layers on existing `pull_request_target` + sandboxed checkout + `persist-credentials: false`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.github/workflows/untrusted-pr-gate.yml` ships; triggers on `pull_request_target`; layers on AISDLC-381 hardening
- [ ] #2 4-stage orchestration: Stage 0 → Stage 1 → Stage 2/3 → Stage 4; pipeline halts at first abort
- [ ] #3 Composes with `ai-sdlc/pr-ready` rollup (added as required check; does NOT replace existing checks)
- [ ] #4 `.ai-sdlc/untrusted-pr-gate.yaml: deployment: local|ci` config respected; default `ci` (OQ-2 resolution)
- [ ] #5 CI deployment mode: reviewers (Phase 4) run inside CI-side OpenShell sandbox (Phase 3)
- [ ] #6 Local opt-in mode: workflow detects `deployment: local`, hands off to maintainer's local pipeline
- [ ] #7 `AI_SDLC_UNTRUSTED_PR_GATE` feature flag (default `off`); truthy values `1`/`true`/`yes`/`on`; follows RFC-0014/RFC-0015 promotion pattern
- [ ] #8 Degradation path: missing OpenShell → Stage 0/1 still run (cheap defenses preserved); Stage 3 reviewers fall back to static-diff review; clear operator message
- [ ] #9 `Decision: untrusted-pr-gate-degraded-mode` emitted via RFC-0035 G0 when degradation engaged
- [ ] #10 Hermetic tests cover workflow YAML validation, 4-stage orchestration, feature-flag behavior (off + on), deployment-mode switching (ci + local), degradation path
- [ ] #11 AC-1 of RFC: untrusted PR modifying `.github/workflows/**` (or `package.json`, lockfiles, `.ai-sdlc/**`) is blocked by Stage 1 with ZERO LLM and ZERO sandbox spend (end-to-end test in CI)
<!-- AC:END -->
