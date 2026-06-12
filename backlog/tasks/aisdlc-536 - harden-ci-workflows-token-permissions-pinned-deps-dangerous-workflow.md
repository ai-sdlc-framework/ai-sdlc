---
id: AISDLC-536
title: >-
  fix(ci): harden workflows — explicit token permissions, SHA-pin actions,
  triage remaining DangerousWorkflowID CodeQL alerts
status: To Do
assignee: []
labels:
  - security
  - ci
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/ai-sdlc-fix-ci.yml
  - .github/workflows/ci.yml
  - .github/workflows/ai-sdlc-gate.yml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub code-scanning (CodeQL + Scorecard rules) flags a set of **workflow-security**
findings. These are CI/CD hardening, distinct from the source-code findings (AISDLC-535)
and the dependabot dependency alerts (Next/Go bump tasks).

**Note on scope authorization:** this task DOES edit `.github/workflows/**`. The "never edit
workflows" rule guards EXTERNAL/untrusted agents — operator-overseen internal hardening is
permitted (see operator memory `feedback_workflow_edit_rule_scope`). The dispatched dev must
be explicitly authorized to edit workflow files for this task.

**1. `TokenPermissionsID` (HIGH, ~7 alerts).** Workflows lacking an explicit least-privilege
`permissions:` block (top-level or per-job), defaulting to the broad repo token. Add explicit
minimal `permissions:` to each flagged workflow (start `contents: read`, add only what each
job needs, e.g. `statuses: write`, `pull-requests: read`, `id-token: write`).

**2. `PinnedDependenciesID` (MEDIUM).** Actions referenced by tag/branch instead of a full
commit SHA in `.github/workflows/ai-sdlc-gate.yml` and `.github/workflows/ci.yml`. Pin each
third-party action to a full-length commit SHA with a `# vX.Y.Z` trailing comment (the repo
already does this for `actions/checkout` — match that convention).

**3. Remaining `DangerousWorkflowID` CRITICAL alerts (#144, #145, #159, #160).** Triage each:
- `untrusted-pr-gate.yml:91` (#144) + `:311` (#145) — the RFC-0043 UCVG Stage-1 (data-only AST
  gate) + sandbox stage. Same already-analyzed AISDLC-381/RFC-0043 mitigated pattern as the
  untrusted-checkout alerts dismissed 2026-06-12 (sandboxed pr-content/, persist-credentials:
  false, network=none sandbox). Likely dismiss-with-reason — confirm no NEW exec path, then
  dismiss the specific alert.
- `ai-sdlc-review.yml:298` (#160) + `ai-sdlc-fix-ci.yml:45` (#159) — NOT yet analyzed. Read
  each: if it's `pull_request_target` + checkout of PR head ref used unsafely (e.g. PR-head
  `ref` interpolated into a `run:` step, or fork code executed with the elevated token), it's a
  REAL pwn-request vector — fix (gate on label/author, move execution off pull_request_target,
  or sandbox + persist-credentials:false). If it's a mitigated/data-only pattern, dismiss with
  a documented reason.

Pull live alert numbers via `gh api repos/<org>/<repo>/code-scanning/alerts?state=open` —
they drift. Workflow YAML changes are docs-exempt for attestation only if AISDLC-534 lands
first; otherwise this is a code PR needing attestation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every workflow flagged by `TokenPermissionsID` has an explicit least-privilege `permissions:` block (top-level and/or per-job); the alerts close
- [ ] #2 Actions flagged by `PinnedDependenciesID` in ai-sdlc-gate.yml + ci.yml are pinned to full commit SHAs with version comments
- [ ] #3 `ai-sdlc-review.yml:298` and `ai-sdlc-fix-ci.yml:45` DangerousWorkflowID alerts are each either FIXED (if a real unsafe pull_request_target/PR-head execution) or dismissed-with-documented-reason (if confirmed mitigated)
- [ ] #4 `untrusted-pr-gate.yml` #144/#145 confirmed against the RFC-0043 mitigation and dismissed-with-reason (or fixed if a new exec path is found)
- [ ] #5 Workflow YAML still passes existing `.github/workflows/__tests__/*` hermetic tests; no workflow is broken (verify with a dry trigger / act-style check where feasible)
- [ ] #6 Post-change CodeQL re-scan shows the targeted workflow alerts closed/dismissed
<!-- AC:END -->
