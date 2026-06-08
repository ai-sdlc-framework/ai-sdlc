---
id: AISDLC-523
title: >-
  chore(deps): land pending major dependency updates (react 18→19, TypeScript
  5→6, commitlint 19→21, github-actions group)
status: Done
assignee: []
created_date: '2026-06-07 23:22'
labels:
  - dependencies
  - chore
  - 'ci:no-issue-required'
dependencies: []
references:
  - .github/dependabot.yml
  - dashboard/package.json
  - pipeline-cli/package.json
  - package.json
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Several dependabot PRs are stuck because they are MAJOR-version bumps with real breaking changes (not auto-mergeable). This task applies them with the necessary code/config migrations so the bumps land green, superseding the stuck dependabot PRs.

Context: after #873 (react grouping) + #876 (ignore react PATCH churn), the remaining dependabot PRs are genuine major upgrades that need migration work:
- #786 / #836 — react 18.3.1 → 19.x (+ react-dom in lockstep, + @types/react 19.x). Affects `dashboard/` (Next.js) and `pipeline-cli/`. React 19 has breaking changes (removed legacy APIs, ref-as-prop, stricter types) — needs a real migration pass, not just a version bump.
- #874 — typescript 5.9.3 → 6.0.3 (major). Likely surfaces new type errors / config changes across packages.
- #787 / #875 — @commitlint/cli + @commitlint/config-conventional 19.x → 21.x (major). May need commitlint config updates.
- #872 — github-actions group (13 action updates). Identify which action bump (if any) breaks `Build & Test` and pin/adjust it.

Approach guidance: tackle these as INDEPENDENT, separable upgrades — do the tractable ones (commitlint, github-actions, TypeScript) first and land what builds green. The react 18→19 major is the largest; if it cannot be completed cleanly within this task's iteration budget, ESCALATE it (return prUrl:null with notes describing the remaining React 19 migration work) rather than shipping a broken or half-migrated dashboard. Do NOT bundle a broken react migration with the working smaller bumps.

After each bump, run the full local verification (build/test/lint/format) and fix resulting errors. The dashboard's exact react/react-dom version match must hold (`dashboard` build asserts it).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 TypeScript bumped to 6.x across the workspace and `pnpm build` (tsc) passes with no new type errors (or, if TS 6 requires non-trivial migration, that subset is escalated with notes)
- [x] #2 @commitlint/cli and @commitlint/config-conventional bumped to 21.x and the commitlint config still validates conventional commits (commit-msg hook works)
- [x] #3 github-actions group updates applied; all workflow YAML remains valid and Build & Test passes (any single action bump that breaks CI is identified and pinned/held with a note)
- [ ] #4 react + react-dom bumped to the SAME 19.x version in both dashboard/ and pipeline-cli/ with @types/react(-dom) matching, and `dashboard` next build passes the exact-version check — OR the react 18→19 migration is escalated (prUrl:null + notes) if it cannot be completed cleanly this iteration
- [x] #5 Full local verification passes for everything that is landed: pnpm build, pnpm test, pnpm lint, pnpm format:check
- [x] #6 Each landed bump updates pnpm-lock.yaml consistently (no partial/mismatched lockfile)
<!-- AC:END -->

## Final Summary

## Summary
Landed three of four major dependency bumps (github-actions group, commitlint 19→21, TypeScript 5→6) with full local verification passing. React 18→19 migration for pipeline-cli is escalated — see notes below.

## Changes
- `.github/workflows/*.yml` (19 files): bumped 13 GitHub Actions to latest SHAs (actions/checkout v4→v6.0.3, pnpm/action-setup v4→v6.0.8, actions/setup-node v4→v6.4.0, actions/github-script v7→v9.0.0, actions/upload-artifact v4→v7.0.1, actions/download-artifact v4→v8.0.1, actions/dependency-review-action v4 SHA update, actions/setup-python v5→v6.2.0, actions/setup-go v5→v6.4.0, codecov/codecov-action v5→v7.0.0, googleapis/release-please-action v4→v5.0.0, github/codeql-action v3 SHA update, dorny/paths-filter v3→v4)
- `.github/workflows/__tests__/action-pinning.test.mjs`: updated TAG_PINNED_ALLOWLIST from paths-filter@v3 to @v4
- `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`: updated test assertion from paths-filter@v3 to @v4
- `package.json`: bumped @commitlint/cli and @commitlint/config-conventional from ^19.8.1 to ^21.0.2
- `dashboard/package.json`, `pipeline-cli/package.json`, `mcp-advisor/package.json`, `dogfood/package.json`, `orchestrator/package.json`, `sdk-typescript/package.json`, `reference/package.json`, `ai-sdlc-plugin/mcp-server/package.json`, `conformance/runner/package.json`: bumped typescript from ^5.7.0 to ^6.0.3
- `pnpm-lock.yaml`: updated lockfile for all landed bumps

## Design decisions
- **dorny/paths-filter v4 as tag (not SHA)**: Maintained as tag-pinned (same as v3 was), updated both the workflow files and the TAG_PINNED_ALLOWLIST in action-pinning.test.mjs
- **React 18→19 escalation for pipeline-cli**: pipeline-cli uses ink@5.x which requires react@^18.3.1. Bumping to React 19 would require also bumping ink 5→6 (a separate major version bump with its own API changes). Dashboard already has react 19 and builds green. The pipeline-cli react bump is escalated.

## Verification
- `pnpm build` — clean (all 9 packages including dashboard Next.js build)
- `pnpm test` — 310 test files, 6933 tests passed, 0 failures
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `commitlint` smoke test: valid conventional commit accepted, invalid message rejected with correct errors

## Follow-up
- React 18→19 for pipeline-cli: requires bumping ink@5→6 (react 19 compatible), updating ink-testing-library if needed, and verifying no TUI rendering regressions. This is a non-trivial migration that should be a separate task.
