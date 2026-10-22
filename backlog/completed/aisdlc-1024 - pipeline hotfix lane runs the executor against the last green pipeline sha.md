---
id: AISDLC-1024
title: >-
  Pipeline hotfix lane: a task labelled `pipeline-hotfix` executes with the last canary-green pipeline-cli build, never through its own bug
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline
  - root-cause
  - containment
dependencies:
  - AISDLC-1023
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/dispatch/claim-wait.ts
  - docs/operations/backlog-and-execution-reference.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (RCA of the 2026-10-21 Step 10.5 outage).** The hotfix for the broken Step 10.5 had to be shipped by the broken Step 10.5. Its task body carried a hand recovery (stage the ledger by hand, chore commit, sign, lease push, flip ready), every executor that reached the wall needed the same note, and the first attempts failed on choreography rather than code. Dogfood executors resolve pipeline-cli from this repo's own build at `main` HEAD (`resolve-pipeline-cli.sh`), so a bad merge is live on every executor within minutes and there is no sanctioned way to run a fix with the previous build.

**Root cause.** The executor has no way to run a task with a pipeline build other than HEAD.

**Five-step review (requirements first).**
1. Requirement questioned: "executors always run HEAD". Kept as the default (dogfood on HEAD is the point); one explicit exception for the hotfix lane.
2. Delete: the hand-recovery prose pattern in hotfix task bodies; it is replaced by the lane.
3. Simplify: `resolve-pipeline-cli.sh` honours `AI_SDLC_PIPELINE_REF=<sha>`: it builds (or reuses from `.ai-sdlc/pipeline-builds/<sha>/`) pipeline-cli at that commit in a detached scratch worktree outside `.worktrees/`, and prints which build it chose. The last canary-green sha is recorded by the canary task's green handler in `.ai-sdlc/dispatch/pipeline-known-good.json`.
4. Accelerate: when an executor claims a task labelled `pipeline-hotfix` while `pipeline-known-good.json` names a sha older than HEAD, `/ai-sdlc execute` exports `AI_SDLC_PIPELINE_REF` to that sha for the whole run and the PR body records it; the attestation envelope's pipeline version field already names the build, so the verifier accepts it.
5. Automate: a shell test for the resolve script and a unit test for the claim-side export; no new session or loop.

**Velocity impact.** Zero on the happy path; a pipeline hotfix lands in one normal run instead of a hand-recovered one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `resolve-pipeline-cli.sh` with `AI_SDLC_PIPELINE_REF=<sha>` builds or reuses pipeline-cli at that sha outside `.worktrees/` and prints the chosen build (shell test)
- [x] #2 `/ai-sdlc execute` on a task labelled `pipeline-hotfix` exports `AI_SDLC_PIPELINE_REF` from `.ai-sdlc/dispatch/pipeline-known-good.json` when that sha differs from HEAD, and the PR body states the pipeline sha used (unit test)
- [x] #3 The attestation verifier accepts an envelope produced by a known-good build older than HEAD when the PR carries the `pipeline-hotfix` label (unit test)
- [x] #4 `docs/operations/backlog-and-execution-reference.md` documents the lane: label, env var, known-good file, and that the default stays HEAD
- [x] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
