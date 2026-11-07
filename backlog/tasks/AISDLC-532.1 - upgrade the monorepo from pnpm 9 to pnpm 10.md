---
id: AISDLC-532.1
title: 'Upgrade the monorepo from pnpm 9 to pnpm 10 (prerequisite for npm OIDC trusted publishing)'
status: To Do
assignee: []
created_date: '2026-11-07'
labels:
  - chore
  - release
  - ci:no-issue-required
dependencies: []
references:
  - package.json
  - pnpm-lock.yaml
  - .github/workflows/release.yml
  - .github/workflows/ai-sdlc-gate.yml
priority: medium
dispatchable: true
---

## Description

**Source.** Step (a) of the umbrella task AISDLC-532 by operator ruling 2026-11-07. `package.json` pins `"packageManager": "pnpm@9.15.4"` and `engines.pnpm: ">=9"`. pnpm 9 cannot publish through npm OIDC trusted publishing; the OIDC exchange in `pnpm publish` arrived in pnpm 10.x. The pnpm major is useful on its own and is the only code prerequisite for the OIDC switch (AISDLC-532.2), so it lands alone.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the only hard requirement is a `pnpm publish` that supports OIDC; that needs pnpm 10, nothing else. 2. Deleted: nothing. 3. Simplified: one PR that changes `packageManager` to the lowest pnpm 10.x release whose notes state OIDC trusted publishing support (cite the release note in the PR body), widens `engines.pnpm` to match, regenerates `pnpm-lock.yaml` with that version, and fixes only what the major breaks (lockfile format, hoisting and `node-linker` defaults, `pnpm -r` flag changes, `pnpm/action-setup` reading `packageManager`). No other change rides in the PR. 4. Accelerated: the pin lands atomically through corepack, so every workflow and local checkout switches together. 5. Automated: CI (`ai-sdlc-gate.yml`) is the proof; no new tooling.

`release.yml` is unchanged in this task: the publish step still uses `NODE_AUTH_TOKEN` and `--provenance` until AISDLC-532.2.

## Acceptance Criteria

- [ ] #1 `package.json` `packageManager` names a pnpm 10.x release whose release notes state OIDC trusted-publishing support, cited in the PR body; `engines.pnpm` admits it.
- [ ] #2 `pnpm-lock.yaml` is regenerated with that version and `pnpm install --frozen-lockfile` succeeds in CI.
- [ ] #3 `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm format:check` are green on CI for the PR.
- [ ] #4 `.github/workflows/release.yml` has no diff in this PR.
- [ ] #5 The PR body lists every pnpm 10 behaviour change that affected the repo (for example hoisting or `node-linker` defaults, lockfile version, removed flags) and what was done about each; nothing unrelated is in the diff.

## Ruling 2026-11-07 (operator, decision rubric)

Option A of the 2026-11-07 ruling on AISDLC-532: the pnpm major is useful on its own and is the only code prerequisite for OIDC; splitting it from the `release.yml` switch keeps each step reversible. Counter-argument (a pnpm major during a pending release is risky) rebutted because the pin lands atomically via corepack and the release path does not change until AISDLC-532.2.

## References

- `package.json` (`packageManager`, `engines`), `pnpm-lock.yaml`.
- `.github/workflows/release.yml` (`publish-npm` job, left unchanged here).
