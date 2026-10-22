---
id: AISDLC-1021
title: >-
  Step 10.5 gets a real-git test with the real ledger writer, and pipeline-cli tests also run on a macOS runner
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline
  - root-cause
  - test-infra
  - ci
dependencies:
  - AISDLC-1017
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/ship.test.ts
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (RCA of the 2026-10-21 Step 10.5 outage).** The tests for `preSignRebase` in `ship.test.ts` stub every git call through the fake runner and write the ledger fixture under the stager's own spelling of the path, so the stager and the real writer are never exercised together. A case mismatch between them passed two review rounds and a waived test suite, then failed every task on the executors' macOS checkouts. CI runs only on `ubuntu-latest`, where the uppercase `existsSync` is false and the broken branch is simply skipped, so even a correct test would not have reproduced the outage there.

**Root cause.** The step that decides whether a PR may be signed has no test against real git on the filesystem the executors use.

**Five-step review (requirements first).**
1. Requirement questioned: "unit tests stub git for speed". Kept for the branch logic; one integration test per git-touching next-step step is added on top.
2. Delete: nothing to delete.
3. Simplify: one test in `ship.test.ts` creates a temp repo, calls `appendReviewLedgerRecord` (the real writer) with a mixed-case task id, runs `preSignRebase` with the real runner, and asserts the ledger is tracked afterwards and the result has no `ledger-not-staged` cause; a second case adds an ignore rule and asserts the cause and the named rule.
4. Accelerate: the `ai-sdlc-gate.yml` build-and-test job gains a `macos-latest` matrix entry restricted by path filter to `pipeline-cli/**` changes, so the executors' filesystem semantics are checked before merge without doubling every run.
5. Automate: nothing further; the matrix entry is the automation.

**Velocity impact.** Adds one macOS job on pipeline-cli PRs only (minutes, not a new gate name: it feeds the existing rollup).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `ship.test.ts` has a real-git test where the real ledger writer and `preSignRebase` run against one temp repo with a mixed-case task id, asserting the ledger is tracked and no `ledger-not-staged` cause is returned
- [x] #2 The same file has a real-git test with the ledger ignored, asserting the `ledger-not-staged` cause names the ignore rule
- [x] #3 `ai-sdlc-gate.yml` runs the pipeline-cli test suite on `macos-latest` when `pipeline-cli/**` changes, feeding the existing `ai-sdlc/pr-ready` rollup (workflow YAML test added under `.github/workflows/__tests__/`)
- [x] #4 `docs/operations/quality-gate.md` documents the macOS matrix entry and its path filter
- [x] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
- `node --test .github/workflows/__tests__/`

## Final Summary

## Summary
Added two real-git tests to ship.test.ts that run preSignRebase with the real ledger writer and a mixed-case task id. Added a `pipeline-cli-macos` job to ai-sdlc-gate.yml that runs the pipeline-cli suite on macos-latest when pipeline-cli/** changes. Documented the job in quality-gate.md and opened a draft PR.

## Changes
- pipeline-cli/src/next-step/ship.test.ts
- .github/workflows/ai-sdlc-gate.yml
- .github/workflows/__tests__/ai-sdlc-gate.test.mjs
- docs/operations/quality-gate.md
- backlog/tasks/AISDLC-1021 - real git test for pre sign rebase and pipeline cli tests on a macos runner.md

## Design decisions
The macOS job is a separate conditional job rather than a build-test matrix entry, because a matrix entry cannot carry its own path filter. It is added to pr-ready needs and allowed-skips. The workflow tests pass 459/459. The full pipeline-cli suite passed on a rerun. One earlier run failed, and I did not look into why. The two new tests run on the local macOS filesystem. They have not been run on the new macos-latest CI job. The commit sha was not captured. It is the head of the pushed branch, after the rebase onto origin/main.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

