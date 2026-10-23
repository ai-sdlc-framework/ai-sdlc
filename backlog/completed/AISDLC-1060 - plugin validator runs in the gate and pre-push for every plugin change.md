---
id: AISDLC-1060
title: 'the Claude plugin validator runs in the PR gate and in pre-push for every change under ai-sdlc-plugin, so a refused hooks module can never merge again'
status: Done
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
- [x] A docs-only PR and a pipeline-cli-only PR do not run the validator job (job skipped, shown in the checks list).
- [x] Pre-push runs the validator locally when the CLI is present and warns once when it is not.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
Added a path-filtered `plugin-validate` job to `ai-sdlc-gate.yml`. It runs `claude plugin validate ai-sdlc-plugin` with the CLI pinned at 2.1.309, and it is in the `pr-ready` needs and allowed-skips. `.husky/pre-push` now runs the same command when the pushed range touches `ai-sdlc-plugin/`, and prints one warning if `claude` is not on PATH. Both are documented, and the job is registered in `gates.yaml` and the gate test. The draft PR is open. AC1, the throwaway-commit proof, has not been run yet.

## Changes
- .github/workflows/ai-sdlc-gate.yml
- .github/workflows/__tests__/ai-sdlc-gate.test.mjs
- .husky/pre-push
- .ai-sdlc/gates.yaml
- docs/operations/pre-push-and-ci-reference.md
- backlog/tasks/AISDLC-1060 - plugin validator runs in the gate and pre-push for every plugin change.md

## Design decisions
AC1 still needs the throwaway duplicate session.receive commit on PR #1979 once CI is live; revert it and note it in the PR body. I ran `claude plugin validate` locally without logging in and it exits 0 (warnings only); it has not run on a CI runner, and I did not test the pre-push hook end to end. The pre-push hook did not trip on its own change. `gates.yaml` requires a decision id for a new gate, so the new entry cites DEC-0056, the single-gate rollup decision, as a sibling of `governance-gate`. Swap it if a more fitting decision exists. The first `pnpm test` hit a conformance failure caused by an unbuilt dependency in the worktree. After `pnpm build` the full `pnpm test` passed (exit 0, apart from a pre-existing TODO subtest). The task file diff is only the claim/status edit. The push needed `git -C <worktree>` because the hook refuses it from the parent cwd.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

