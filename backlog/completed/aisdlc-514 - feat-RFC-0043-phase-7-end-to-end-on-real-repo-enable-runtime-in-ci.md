---
id: AISDLC-514
title: 'feat(e2e): RFC-0043 Phase 7 — end-to-end on a real test repo + enable Docker runtime in CI'
status: Done
assignee: []
labels:
  - rfc-0043
  - phase-7
  - e2e
  - milestone
dependencies:
  - AISDLC-513
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - .github/workflows/untrusted-pr-gate.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The milestone (W7): the gate runs end-to-end on a real repository with a real fork PR. Stand up a dedicated test repo configured for the gate, re-enable the runtime in the workflow (the OpenShell install step is currently disabled "may hang the runner" — replace with the Docker path per AISDLC-507/508), and demonstrate the full pipeline.

**This is the point at which "send a live demo" becomes a true statement** — until this passes, do not offer external live demos on arbitrary repos.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 A test repo configured with `.ai-sdlc/untrusted-pr-gate.yaml`, `trusted-reviewers.yaml`, the `untrusted-pr-gate.yml` workflow, and a signing key — templates shipped in `docs/ucvg-test-repo-setup/`
- [x] #2 `untrusted-pr-gate.yml` runs the Docker runtime path (disabled OpenShell install replaced/guarded); the watchdog + fail-closed degradation still behave correctly — `command -v docker` check replaces `command -v openshell`; `.nvmrc` added + both `node-version-file` refs replaced with `node-version: 22`; all 58 workflow YAML tests pass
- [ ] #3 **OPERATOR-GATED** — A benign untrusted (fork) PR flows through all four stages and produces a v6 attestation that verifies `status=valid` + posts the success status. Requires: live test repo + signing key + real GitHub Actions runner with Docker + `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`. See `docs/operations/e2e-real-repo-runbook.md`.
- [ ] #4 **OPERATOR-GATED** — Adversarial fork PRs (the AISDLC-513 vectors) are each blocked at the correct stage on the live gate. Requires same infra as AC#3. See `docs/operations/e2e-real-repo-runbook.md`.
- [x] #5 AISDLC-505 (ast-gate glob false-positive) is merged first so benign files aren't mis-blocked — confirmed merged per task brief
- [x] #6 A short runbook documents how to reproduce the e2e run; feature flag flip criteria recorded — `docs/operations/e2e-real-repo-runbook.md`
<!-- AC:END -->

## Notes

Blocking dependency for clean runs: **AISDLC-505** (glob false-positive). Minor test-quality follow-ups AISDLC-503/504 are non-blocking.

**AC#3 and AC#4 are operator-gated.** The dev subagent cannot execute a live end-to-end run with real fork PRs — that requires operator infra (configured test repo, real signing key, live Docker runner, `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`). All code and config changes needed to support that run are shipped in this PR. The operator must execute steps documented in `docs/operations/e2e-real-repo-runbook.md` to complete AC#3 and AC#4.

**nvmrc fix:** both `node-version-file: '.nvmrc'` occurrences in `untrusted-pr-gate.yml` were replaced with `node-version: 22` (matching `ci.yml` convention). A root `.nvmrc` containing `22` was also added to satisfy `node-version-file` if re-adopted later.
