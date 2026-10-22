---
id: AISDLC-1023
title: >-
  Post-merge pipeline canary on macOS runs Steps 10.5 to 11 on a fixture repo; red holds the drain and files a hotfix task
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline
  - ci
  - root-cause
  - containment
dependencies:
  - AISDLC-1021
references:
  - .github/workflows/main-health-monitor.yml
  - scripts/first-run-smoke.mjs
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/bin/cli-hierarchy.mjs
  - pipeline-cli/bin/cli-file.mjs
  - docs/operations/main-health-monitor.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (RCA of the 2026-10-21 Step 10.5 outage).** After a merge broke Step 10.5, nothing on `main` noticed. `main-health-monitor.yml` runs build, tests, lint, coverage and the first-run smoke on `ubuntu-latest`; the smoke drives the legacy `executePipeline` path, which never calls `preSignRebase`, and Linux hides the case bug anyway. The outage was detected by the first executor to die, and the drain stayed stopped for a day while a hotfix was filed, queued and run by hand.

**Root cause.** No post-merge check exercises the code path the executors run next, on the filesystem they run it on, and no automatic response exists when `main` is broken for the pipeline.

**Five-step review (requirements first).**
1. Requirement questioned: "main-health is a test rerun". Extended to: main-health proves the pipeline can still ship a PR.
2. Delete: nothing to delete; the first-run smoke stays for the legacy path.
3. Simplify: a `scripts/pipeline-canary.mjs` that builds a temp fixture repo with a fake task, a fake review ledger written by the real writer, and a fake attestation, then runs `next-step` from Step 10.5 to the point just before the push with a stubbed `gh` and a local bare remote, asserting the run reaches Step 11 with no `cause`. It runs as a named job on `macos-latest` in `main-health-monitor.yml`, on every push to `main`, not `continue-on-error`.
4. Accelerate: when the canary job fails, the workflow posts the failing step and sha to the RFC-0054 webhook, and the dispatch tick, on receiving a `pipeline-canary-red` event, runs `cli-hierarchy hold --reason "pipeline canary red at <sha>"` and files a hotfix task with `cli-file` carrying the `pipeline-hotfix` label and the canary output; a later green canary lifts the hold with `cli-hierarchy resume`.
5. Automate: nothing beyond the workflow and the tick handler; both have unit tests.

**Velocity impact.** One macOS job per push to `main` (about five minutes). Converts a day-long silent outage into a held drain plus a filed hotfix within one CI run.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `scripts/pipeline-canary.mjs` runs `next-step` Steps 10.5 to 11 (push stubbed) on a generated fixture repo whose ledger is written by the real writer, exits non-zero with the step and cause on failure, and reproduces the 2026-10-21 bug when run against commit fce26ed50
- [ ] #2 `main-health-monitor.yml` runs the canary as a non-optional job on `macos-latest` on every push to `main` (workflow YAML test added)
- [ ] #3 A red canary sends a `pipeline-canary-red` event with the sha to the webhook; the dispatch tick sets a hold with that reason and files a hotfix task labelled `pipeline-hotfix` through `cli-file`; a green canary after a red one lifts the hold (unit tests on the tick handler)
- [ ] #4 `docs/operations/main-health-monitor.md` documents the canary, the hold and the hotfix filing, with the manual lift command
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node scripts/pipeline-canary.mjs` on a clean checkout of `main`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
- `node --test .github/workflows/__tests__/`
