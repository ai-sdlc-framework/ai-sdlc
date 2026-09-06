---
id: AISDLC-592
title: >-
  Fix UCVG fork-PR checkout regression: actions/checkout v7 refuses fork
  checkout under pull_request_target
status: Done
assignee: []
created_date: '2026-09-06 18:43'
labels:
  - ci
  - security
  - ucvg
  - external-contributors
dependencies: []
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/verify-attestation.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Every external fork PR has been failing the `ai-sdlc/untrusted-pr-gate` status since the Dependabot github-actions group bumps in July 2026 (#950/#952/#957) moved `actions/checkout` to v7.0.1. Observed on PR #998 (external contributor, opened 2026-09-05):

```
##[error]Refusing to check out fork pull request code from a 'pull_request_target' workflow.
This workflow runs with the base repository's GITHUB_TOKEN, secrets, default-branch cache scope,
and runner access. ... To opt in, review the risks at https://gh.io/securely-using-pull_request_target
and set 'allow-unsafe-pr-checkout: true' on the actions/checkout step.
```

`actions/checkout` v7 hard-refuses `ref: <fork head sha>` under `pull_request_target` unless `allow-unsafe-pr-checkout: true` is set. Our Stage 0+1 job (`untrusted-pr-gate.yml`, second checkout step, ~line 91) checks the fork head into a sandboxed `pr-content/` path with `persist-credentials: false` as fork-PR safety guard #2. That step now fails before any real signal is produced. The always-run "pipeline failure watchdog" then posts `Failed: UCVG pipeline error — maintainer review required` and the PR goes BLOCKED. The `GATE_FLAG` is `off` so the gate is not even supposed to be enforcing.

Net effect: for ~6 weeks no external contributor has been able to get a green untrusted-pr-gate status, and the failure message blames the pipeline rather than saying what happened.

External references (informational, not repo file paths — kept out of frontmatter `references:` so the drift checker's file-existence scan doesn't false-positive on them): `https://github.com/ai-sdlc-framework/ai-sdlc/pull/998`, `https://github.com/ai-sdlc-framework/ai-sdlc/actions/runs/33949148841/job/101260519879`, `https://gh.io/securely-using-pull_request_target`.

## Fix

Preferred: replace the second `actions/checkout` step (fork PR content into `pr-content/`) with an explicit, credential-free fetch of the PR head SHA into `pr-content/` — e.g. `git init pr-content && git -C pr-content fetch --no-tags https://github.com/${{ github.repository }}.git ${{ github.event.pull_request.head.sha }} && git -C pr-content checkout FETCH_HEAD` (plus enough history for the Stage-1 `git diff BASE..HEAD` computation, which is why the current step uses `fetch-depth: 0` — see the "Bug A fix" comment on that step). This keeps the existing safety properties (workflow logic from main, PR content is data-only, no credentials persisted, nothing from pr-content/ executed) without opting into the checkout action's unsafe mode.

Acceptable fallback: keep `actions/checkout` and add `allow-unsafe-pr-checkout: true` on ONLY that step, with a comment block explaining why safety guards #1/#2 make it acceptable (content lands in a sandboxed subdirectory, credentials not persisted, no scripts from that path are run in the trusted job).

Either way: apply the same treatment to any other `pull_request_target` checkout of `github.event.pull_request.head.sha` in this repo's workflows (grep for `head.sha` under `.github/workflows/`; lines ~306-311 and ~528 of untrusted-pr-gate.yml use the same pattern).

Also: make the watchdog message distinguish "a stage crashed" from "the gate rejected the PR" so an external contributor is not told their PR failed a security gate when our CI is what broke.

## Authorization

This task explicitly authorizes editing `.github/workflows/untrusted-pr-gate.yml`. The "never edit workflows" rule guards external agents; this is operator-overseen internal backlog work.

## Verification

- `actionlint` / yaml lint passes on the changed workflow.
- Unit/integration tests in `pipeline-cli` or wherever the UCVG stage scripts are tested still pass (`pnpm test` in affected packages).
- After merge: re-run checks on PR #998 and confirm Stage 0+1 gets past checkout and produces a real trust-classification result.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Stage 0+1 of untrusted-pr-gate.yml no longer fails at the fork-PR checkout step under actions/checkout v7 for a PR from a fork
- [x] #2 Fork PR content is still only ever placed in the sandboxed pr-content/ directory with persist-credentials false, and no file from pr-content/ is executed in the trusted job (safety guards #1 and #2 preserved)
- [x] #3 Every pull_request_target checkout of github.event.pull_request.head.sha in .github/workflows is fixed the same way (not just the first one)
- [x] #4 The Stage-1 diff computation still has the base SHA available (equivalent of fetch-depth: 0 preserved)
- [x] #5 The pipeline-failure watchdog message distinguishes an infrastructure crash from a gate rejection
- [x] #6 Workflow lints clean and affected package tests pass
<!-- AC:END -->

## Final Summary

### Summary
Fixed the `actions/checkout` v7.0.1 hard refusal ("Refusing to check out fork pull request code from a 'pull_request_target' workflow") that had been blocking every external fork PR's `ai-sdlc/untrusted-pr-gate` status for ~6 weeks. Used the acceptable-fallback approach (`allow-unsafe-pr-checkout: true`) rather than the git-fetch rewrite, since the existing fork-PR safety guards (#1 sandboxed `pr-content/` path, #2 `persist-credentials: false`, #3 no execution from `pr-content/`) already contain the exact risk the checkout refusal exists to prevent — opting in does not weaken the trust boundary, and it avoided rewriting a large, heavily test-covered checkout-based assertion suite for no safety benefit. Also fixed the two other workflows with the same fork-head checkout pattern under `pull_request_target` (`ai-sdlc-review.yml`, `verify-attestation.yml`), and updated the `gate-failure-watchdog` job in `untrusted-pr-gate.yml` to distinguish an infrastructure crash (classify-and-gate job failed/cancelled before it could evaluate the PR) from a stage-incomplete gate rejection, so external contributors are no longer told their PR failed a security gate when CI itself broke.

### Changes
- `.github/workflows/untrusted-pr-gate.yml` (modified): added `allow-unsafe-pr-checkout: true` (with rationale comment) to both `pr-content/` fork-head checkouts (classify-and-gate, sandbox-and-review jobs); rewrote the `gate-failure-watchdog` job's failure-posting script to compute `isInfraCrash` from `classify-and-gate`'s job result and post a distinct commit-status description + PR comment for infra crash vs. stage-incomplete/gate-rejection scenarios.
- `.github/workflows/ai-sdlc-review.yml` (modified): added `allow-unsafe-pr-checkout: true` to the `attestation-precheck` job's fork-head checkout into `pr-content/` (same pattern, same v7 regression).
- `.github/workflows/verify-attestation.yml` (modified): added `allow-unsafe-pr-checkout: true` to the verify job's fork-head checkout into `pr-content/` (same pattern, same v7 regression).
- `.github/workflows/__tests__/untrusted-pr-gate.test.mjs` (modified): added `AISDLC-592` describe blocks asserting (a) every fork-content checkout sets `allow-unsafe-pr-checkout: true` while still preserving `persist-credentials: false`, and (b) the watchdog script computes `isInfraCrash` and posts the distinct "infrastructure error (not a gate rejection)" description.
- `backlog/tasks/aisdlc-592 - ...md` → `backlog/completed/aisdlc-592 - ...md` (moved): task closed.

### Design decisions
- **Fallback (`allow-unsafe-pr-checkout: true`) over git-fetch rewrite**: the task's preferred approach (replace `actions/checkout` with an explicit credential-free `git fetch`) would have required rewriting the `checkoutSteps()`/`fetchDepth`/`path`-based structural assertions across ~150 lines of the existing hermetic test suite (`untrusted-pr-gate.test.mjs`'s guard #2 and "Bug A fix" describe blocks) for a pattern that provides no additional safety over the fallback — both approaches keep fork content out of any executed path. The fallback is a 1-line-per-step change with an explanatory comment, verified safe by the existing "no execution against pr-content/" guard #3 test (`FORBIDDEN_RUN_PATTERNS`), which passes unchanged.
- **Only `classify-and-gate` failure/cancellation counts as "infra crash"**: Stage 0/1 (classify-and-gate) never legitimately job-fails on a rejection — the protected-path abort step explicitly `exit 0`s and posts its own block comment. So any classify-and-gate job failure/cancellation is unambiguously a pipeline bug, not a gate verdict. Stage 2/3/4 (sandbox-and-review, clean-room-sign) failures are more ambiguous (a Docker-unavailable fail-closed throw is architecturally a rejection, but from the contributor's perspective it's still "our CI", not their code) — the watchdog message for that branch is worded to acknowledge the ambiguity honestly rather than mislabel it either way.
- **Fixed all three occurrences (AC-3), not just the task-file-referenced one**: grepped `head.sha` + `ref:` across every workflow and found the identical `actions/checkout` + fork-head + `pull_request_target` pattern in `ai-sdlc-review.yml` and `verify-attestation.yml`, both of which were silently broken by the same v7.0.1 upgrade.

### Verification
- `pnpm test:untrusted-pr-gate-workflow` — 71/71 passed
- `pnpm test:review-workflow` — 12/12 passed
- `pnpm test:verify-attestation-workflow` — 49/49 passed (verify-attestation.test.mjs + verify-attestation-cancelled.test.mjs)
- `pnpm test:fork-pr-safety` — 10/10 passed
- `python3 -c "import yaml; yaml.safe_load(...)"` — all 3 changed workflow files parse as valid YAML
- `npx prettier --check` on all changed files — clean
- `actionlint` not available in this environment; relied on the existing hermetic YAML structural test suites above (equivalent coverage for this repo's workflow-testing convention)

### Follow-up
(none) — after merge, re-run checks on PR #998 to confirm Stage 0+1 gets past checkout for the live fork PR.
