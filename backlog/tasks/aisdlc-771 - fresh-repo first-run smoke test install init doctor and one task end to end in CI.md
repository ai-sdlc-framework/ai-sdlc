---
id: AISDLC-771
title: >-
  fresh-repo first-run smoke test: install, init, doctor and one task end to end in CI
status: To Do
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

- [ ] `scripts/first-run-smoke.sh` exits 0 on clean main.
- [ ] The script fails when a governance hook is missing from the marketplace manifest (regression test for the AISDLC-558 class).
- [ ] Doctor output is asserted error-free.
- [ ] A CI job in `.github/workflows/ci.yml` is wired with the path filter (`ai-sdlc-plugin/**`, `pipeline-cli/**`, `reference/**`) and a nightly schedule.
- [ ] The README "Getting started" section lists the same steps the script runs, verified by the script reading the same command list or by a test that they match.
- [ ] Runtime is under 5 minutes.
