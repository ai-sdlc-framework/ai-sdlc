---
id: AISDLC-1060
title: 'the Claude plugin validator runs in the PR gate and in pre-push for every change under ai-sdlc-plugin, so a refused hooks module can never merge again'
status: In Progress
assignee: []
created_date: '2026-10-23'
labels:
  - ci
  - plugin
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .husky/pre-push
  - ai-sdlc-plugin/hooks/hooks.json
  - scripts/is-docs-only-changeset.mjs
---

## Description

RCA 2026-10-23 (hierarchy outage), cause 1. The hooks module under `ai-sdlc-plugin/hooks/hierarchy/` was refused by `claude plugin validate` from the RFC-0058 phase 2 commit onward (`session.receive` registered twice without a matcher), and three PRs landed on top of it with full reviewer approval. Nothing re-ran the validator after phase 1 recorded it green: CI has no Claude CLI, pre-push does not call it, and the mods Vitest suite models the runtime, not the static validator.

Add the validator as a deterministic gate at both tiers. In `ai-sdlc-gate.yml`, a job that runs only when the changeset touches `ai-sdlc-plugin/**` (use the existing classify step's file list) installs the Claude Code CLI on the runner (npm package, pinned version, no login needed for `validate`; confirm the command runs unauthenticated and record the pinned version in the job) and runs `claude plugin validate ai-sdlc-plugin`, failing the rollup on any error (warnings stay warnings). In `.husky/pre-push`, the same command runs when a pushed commit touches `ai-sdlc-plugin/` and the CLI is on PATH; absent CLI prints one warning line and continues (CI is the gate). Document the gate in `docs/operations/pre-push-and-ci-reference.md`.

**Five-step review (requirements first).** Requirement questioned: is a static validator run needed when the module has unit tests? Yes; the host's loader is the validator, and the tests cannot see duplicate registrations across roles. Deletion: nothing to delete. Simplified: one command, run twice, on a path filter. Accelerated: path-filtered so docs and runtime PRs pay nothing. Automated last: the gate job itself.

## Acceptance Criteria

- [ ] A PR that reintroduces a duplicate `on('session.receive')` in the hooks module fails `ai-sdlc/pr-ready` with the validator's line in the job log (proved by one throwaway commit in the PR, then reverted, noted in the PR body).
- [ ] A docs-only PR and a pipeline-cli-only PR do not run the validator job (job skipped, shown in the checks list).
- [ ] Pre-push runs the validator locally when the CLI is present and warns once when it is not.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
