---
id: AISDLC-704.4
title: >-
  pin pip build dependencies in release.yml and fix identity-replacement in blast-radius-overlap
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
updated_date: '2026-10-07 17:38'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). Two small leftovers from AISDLC-704: alert 175 (PinnedDependenciesID, `.github/workflows/release.yml`: hash-pin the pip build requirements) and alert 61 (js/identity-replacement, `pipeline-cli/src/orchestrator/filters/blast-radius-overlap.ts:345`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The change described above is implemented with tests.
- [x] The listed code-scanning alerts read `fixed` after merge.

## Final Summary

## Summary
Hash-pinned the PyPI build dependencies in release.yml (alert 175) and removed the identity `.replace` in blast-radius-overlap.ts (alert 61).

## Changes
- `.github/workflows/release.yml` (modified): installs `sdk-python/requirements-build.txt` with `--require-hashes`, builds with `--no-isolation`.
- `sdk-python/requirements-build.{in,txt}` (new): pip-compile output with sha256 hashes for build, hatchling and transitive deps.
- `pipeline-cli/src/orchestrator/filters/blast-radius-overlap.ts` (modified): dropped the no-op replace.
- `.github/workflows/__tests__/release-pip-hash-pin.test.mjs` (new): asserts the pinning.

## Design decisions
- **--no-isolation**: otherwise the build fetches an unpinned hatchling, defeating the pin.

## Verification
- `pnpm build` — clean
- `pnpm lint` — clean
- filter vitest suite — 148 passed; new node:test — 3 passed
- 3 reviewers approved

## Follow-up
declined: separating test and build from the id-token job (existing exposure, reviewer suggestion, out of scope)
