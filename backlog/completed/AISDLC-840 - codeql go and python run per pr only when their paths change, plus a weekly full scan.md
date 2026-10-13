---
id: AISDLC-840
title: >-
  codeql go and python run per pr only when their paths change, plus a weekly full scan
status: In Progress
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
  - security
dependencies: []
references:
  - .github/workflows/ci.yml
  - .ai-sdlc/gates.yaml
  - docs/operations/quality-gate.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

CodeQL runs through GitHub default setup on every PR (`code-scanning/default-setup` lists `actions, go, javascript-typescript, python`), so `Analyze (go)` ran 104 s and 127 s on PR 1450 although `sdk-go/` holds the only Go and `Test Go SDK` is already path-gated to it (`docs/audits/2026-10-13-cicd-five-step-audit.md`, finding F3). Default setup cannot path-gate a language.

**Five-step review (requirements first).** Requirement questioned: "every language is scanned on every PR" (the GitHub default-setup choice, never re-asked per language). The operator answered DEC-0161 on 2026-10-13 (option `move`): Go and Python analyses run per PR only when their paths change, plus a weekly full scan. Delete: the unconditional per-PR Go and Python analyses. Simplify: one advanced-setup workflow with a path filter per language. Accelerate: about 2 minutes of runner time saved on PRs that touch neither language. Automate: nothing new. This weakens a scan on paths that do not change, so the weekly full scan is part of the decision and is required here.

## Fix

1. Switch CodeQL from default setup to advanced setup: add `.github/workflows/codeql.yml` with a matrix of `actions`, `javascript-typescript`, `go`, `python`. On `pull_request`, a `dorny/paths-filter` step (same pinned SHA the gate workflow uses) restricts `go` to `sdk-go/**` and `conformance/**` and `python` to `sdk-python/**` and `conformance/**`; `actions` and `javascript-typescript` run on every PR as today. On `schedule` (weekly) and `push` to `main`, all four languages run unfiltered. Pin every action by SHA (`.github/workflows/__tests__/action-pinning.test.mjs`), least-privilege `permissions` (`security-events: write` only on the analyze job), and a `concurrency` group with `cancel-in-progress` for PR events.
2. Disabling default setup is a repository setting (`gh api -X PATCH repos/<owner>/<repo>/code-scanning/default-setup -f state=not-configured`); the executor records the exact command and result in the PR body, and if the executor identity lacks admin rights the operator or dispatch session runs it after landing, since two setups run together double-scan.
3. Register the new workflow in `.ai-sdlc/gates.yaml` with `decision: DEC-0161` (adding an entry requires a decision id) and `owner`, `origin`, `property` filled in; the registry test must pass.
4. Add `.github/workflows/__tests__/codeql.test.mjs` asserting the path filters, the weekly schedule, the main push leg and the SHA pins. Docs: `docs/operations/quality-gate.md` states the per-language scope.

**Velocity impact.** Positive: removes about 2 minutes of CodeQL Go and Python from PRs that touch neither language; the weekly full scan keeps whole-repo coverage.

Authority: DEC-0161 (answered 2026-10-13, operator present; record lands on main via the decisions-sync PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.github/workflows/codeql.yml` exists with the four-language matrix, per-language path filters on pull requests, and an unfiltered weekly schedule plus push to main
- [ ] #2 All actions in the new workflow are SHA-pinned and `action-pinning.test.mjs` passes
- [ ] #3 `.ai-sdlc/gates.yaml` has one new entry carrying `decision: DEC-0161` and `pnpm test:gates` passes
- [ ] #4 `.github/workflows/__tests__/codeql.test.mjs` exists and `node --test .github/workflows/__tests__/` passes
- [ ] #5 The PR body records the default-setup disable command and its result (or states the operator must run it)
- [ ] #6 `docs/operations/quality-gate.md` states the per-language scope and the weekly scan
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
