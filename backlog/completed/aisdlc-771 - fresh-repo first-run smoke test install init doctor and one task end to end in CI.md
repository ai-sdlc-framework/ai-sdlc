---
id: AISDLC-771
title: >-
  fresh-repo first-run smoke test: install, init, doctor and one task end to end in CI
status: Done
assignee: []
created_date: '2026-10-09'
labels:
  - adopter
  - ci
dependencies:
  - AISDLC-558
  - AISDLC-561
references:
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/doctor.ts
  - ai-sdlc-plugin/commands/doctor.md
  - docs/operations/doctor.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/plugin.json
  - pipeline-cli/bin/cli-orchestrator.mjs
  - .github/workflows/ci.yml
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A prospect's first hour is: install the plugin from the marketplace, run `ai-sdlc init`, run `ai-sdlc doctor`, then run one task. Today nothing exercises that path on a clean machine, so first-run regressions (manifest drift in AISDLC-558, misleading session-start claims in AISDLC-561) reach users first. This matters now because the operator is running a public-relations push to GitHub stargazers, and a first-time user must hit very few issues.

Deliverable: a script `scripts/first-run-smoke.sh` (or `.mjs`) that creates a temp git repo with one trivial source file, installs the plugin build from this checkout the way the marketplace would (the manifest at `ai-sdlc-plugin/.claude-plugin/plugin.json`), runs `ai-sdlc init` non-interactively (`orchestrator/src/cli/commands/init.ts`), runs `ai-sdlc doctor` (`orchestrator/src/cli/commands/doctor.ts`) and asserts zero errors, files one toy backlog task, and runs the pipeline offline with the mock spawner (`node pipeline-cli/bin/cli-orchestrator.mjs tick --spawner mock`, or the closest existing offline path) to a committed branch. A CI job in `.github/workflows/ci.yml` runs it on every PR touching `ai-sdlc-plugin/**`, `pipeline-cli/**` or `reference/**`, and nightly.

Sequencing: AISDLC-558 and AISDLC-561 should land first so the test is green at birth.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] `scripts/first-run-smoke.sh` exits 0 on clean main.
- [x] The script fails when a governance hook is missing from the marketplace manifest (regression test for the AISDLC-558 class).
- [x] Doctor output is asserted error-free.
- [x] A CI job in `.github/workflows/ci.yml` is wired with the path filter (`ai-sdlc-plugin/**`, `pipeline-cli/**`, `reference/**`) and a nightly schedule.
- [x] The README "Getting started" section lists the same steps the script runs, verified by the script reading the same command list or by a test that they match.
- [x] Runtime is under 5 minutes.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added an offline fresh-repo first-run smoke test (`scripts/first-run-smoke.mjs`) that mirrors the README "Getting started" steps (install from the marketplace manifest, `ai-sdlc init`, `ai-sdlc doctor`, one toy task through `executePipeline()` with the mock spawner to a pushed branch), plus a `first-run-smoke` CI job on plugin/pipeline-cli/reference path changes and a nightly schedule.

## Changes
- `scripts/first-run-smoke.mjs`, `scripts/first-run-smoke-pipeline.mjs` (new): the smoke and its mock-pipeline helper.
- `scripts/first-run-smoke.test.mjs`, `.github/workflows/__tests__/first-run-smoke.test.mjs` (new): hermetic tests, including a missing-governance-hook regression and ci.yml structure/paren-balance checks.
- `.github/workflows/ci.yml` (modified): new job, paths filter, nightly cron, own concurrency group for schedule.
- `README.md`, `package.json` (modified): Getting started steps, test scripts.

## Design decisions
- **Mock pipeline via executePipeline()**: `cli-orchestrator tick --spawner mock` is plumbing-only and cannot reach a committed branch; the tick is used with `--dry-run` for frontier admission.
- **README is the step source**: the script fails on any README/runner mismatch.

## Verification
- smoke script passes in about 3 s; workflow and script tests, dark-code:check, lint, format:check pass
- 2 reviewers approved (security, code; classifier scoped; Codex unavailable so Claude-native code reviewer used)

## Follow-up
- declined: online-only doctor failure when runtimeDependencies pins (`>=0.29.0`) are ahead of npm (0.28.0) clears on next release publish; not covered by offline smoke
<!-- SECTION:FINAL_SUMMARY:END -->
