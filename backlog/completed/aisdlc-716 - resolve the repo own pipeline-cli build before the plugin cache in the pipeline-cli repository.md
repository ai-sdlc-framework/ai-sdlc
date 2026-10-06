---
id: AISDLC-716
title: >-
  In a repository that contains the pipeline-cli workspace, resolve the repo's own build before the plugin cache
status: Done
assignee: []
created_date: '2026-10-04'
labels:
  - bug
  - dogfood
  - attestation
dependencies: []
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs
  - ai-sdlc-plugin/commands/doctor.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The plugin's `resolve-pipeline-cli.sh` prefers the plugin-cache copy of pipeline-cli over
the repository's own build. In this repository (dogfood) a fix merged to main is therefore
invisible to executor sessions until a plugin release ships it. On 2026-10-04 an executor
ran `emit-leaf` from the cached 0.22.0 build, which predates the attestation leaf binding
fix's main-checkout marker lookup, and produced leaves with a null harnessTranscriptHash.
The attestation could not be signed and a review round was repeated.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [x] When the current repository (the worktree, or its main checkout) contains the pipeline-cli workspace package itself, the resolver returns that repository's build: the worktree's `pipeline-cli/dist` if present and not older than its sources, else the main checkout's, else the plugin cache with a one-line warning on stderr naming which build was chosen and why.
- [x] Adopter repositories (no pipeline-cli workspace) resolve exactly as today: a project-local `node_modules` install, then the plugin cache. A test covers both layouts and the stale-dist fallback.
- [x] A stale or missing repo build is reported with the command that rebuilds it; the resolver never silently runs an older build than the one the repository's sources describe.
- [x] Every plugin command, hook and script that invokes pipeline-cli goes through the resolver (list them in the PR; fix the ones that hardcode the cache path).
- [x] `/ai-sdlc doctor` (`ai-sdlc-plugin/commands/doctor.md`) reports which pipeline-cli build the session resolves and its version.
- [x] PR body carries a "Velocity impact" section (DEC-0048).

## Out of scope
- Changing how adopters install the CLI.
<!-- SECTION:DESCRIPTION:END -->
