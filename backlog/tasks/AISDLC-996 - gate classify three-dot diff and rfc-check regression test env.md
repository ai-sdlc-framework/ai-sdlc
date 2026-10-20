---
id: AISDLC-996
title: 'Gate classify uses a three-dot diff; rfc-check regression test stops inheriting GITHUB_BASE_REF'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - ci
  - bug
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/__tests__/ai-sdlc-gate.test.mjs
  - scripts/check-rfc-docs.test.mjs
  - scripts/check-rfc-docs.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

Two deterministic reds hit every docs-only PR that is behind `main` or that carries an approved RFC lifecycle jump, observed 2026-10-20 on gate runs 39516244038 and 39497727951.

**Red 1, classify.** `ai-sdlc-gate.yml:131` runs `git diff --name-only "$BASE_SHA" "$HEAD_SHA"` with `BASE_SHA = github.event.pull_request.base.sha`, which GitHub sets to the current tip of the base branch, not to the fork point. For a PR whose head is behind `main` the two-dot diff lists every file `main` gained since the branch forked (154 files for a 7-file PR), so `is-docs-only-changeset.mjs` returns `code`, and the attestation gate and the governance reviewers check fire on a PR that has no code. Locally `git diff origin/main...<head>` lists the 7 real files and classifies `docs-only`. The same two-dot form appears at `:1248` (RFC lifecycle gate file list).

**Red 2, rfc-check regression test.** `scripts/check-rfc-docs.test.mjs:808` ("exits 0 against the real workspace") spawns `check-rfc-docs.mjs` with the inherited CI environment and no `--pr-body`. In a PR run `GITHUB_BASE_REF` is set, so the CLI runs the lifecycle check against the real diff without the PR body and fails any lifecycle jump the operator approved through the documented override marker ("Override marker found in RFC body only — it must ALSO appear in the PR body"), although the `RFC Lifecycle Gate` job, which does pass the PR body, is green. The test duplicates that gate with less information.

Fix: at `:131` and `:1248` diff `"$BASE_SHA...$HEAD_SHA"` (three-dot, from the fork point) and keep the existing fail-safe; extend `.github/workflows/__tests__/ai-sdlc-gate.test.mjs` so the classify step asserts the three-dot form. In `check-rfc-docs.test.mjs:808` spawn the CLI with `GITHUB_BASE_REF` removed from the child env so the regression test checks the doc surfaces only; the lifecycle check keeps its own unit tests in the same file and its CI job.

Out of scope: changing what `is-docs-only-changeset.mjs` allows, the lifecycle override rules, or the attestation gate.

**Five-step review (requirements first).**
1. Requirement questioned: should the regression test run the lifecycle check at all? No: the `RFC Lifecycle Gate` job owns it with the PR body; the test only needs the documentation surfaces.
2. Delete: the lifecycle pass inside the regression test (by dropping the inherited `GITHUB_BASE_REF`).
3. Simplify: one diff form (three-dot) in both places of the gate workflow.
4. Accelerate: docs-only PRs behind `main` stop running the attestation gate, the governance reviewers check and the full matrix.
5. Automate: the gate workflow test asserts the three-dot form so the two-dot form cannot return.

## Acceptance Criteria

- [ ] `ai-sdlc-gate.yml` classify step and the RFC lifecycle file list use `"$BASE_SHA...$HEAD_SHA"`; `ai-sdlc-gate.test.mjs` asserts it.
- [ ] A docs-only PR whose head is behind `main` is classified `docs-only` (`docs_only=true`), so the attestation gate and governance reviewers check skip it.
- [ ] `check-rfc-docs.test.mjs` "exits 0 against the real workspace" passes on a PR branch that carries an approved lifecycle jump (RFC body and PR body markers), because the child process does not inherit `GITHUB_BASE_REF`.
- [ ] Lifecycle-check unit tests in `check-rfc-docs.test.mjs` are unchanged and still pass.
