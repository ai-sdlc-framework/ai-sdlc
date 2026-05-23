---
id: AISDLC-390
title: 'chore: restore pnpm affected-filter for CI Build & Test after fixing transitive-dep build order'
status: Done
labels:
  - ci
  - performance
  - tech-debt
references:
  - .github/workflows/ci.yml
  - scripts/check-coverage.sh
  - docs/operations/gate-friction-audit-2026.md
parentTaskId: AISDLC-384
---

## Description

Follow-up to AISDLC-389 + AISDLC-385.

AISDLC-389 introduced `pnpm --filter "...[origin/main]"` for the CI Build & Test job's `pnpm build` + `pnpm test` steps to skip unchanged packages. The filter works correctly for `test` (each package's tests are independent), but breaks `build` when the filter selects a dependent (e.g. dogfood) without selecting that dependent's foundation dep (e.g. orchestrator). pnpm's filter only walks the dep graph for *changed* packages, not for *unchanged* foundation deps.

Concrete failure observed on PR #609 (AISDLC-385): the dogfood package's `tsc` build failed with `TS2307: Cannot find module '@ai-sdlc/orchestrator'` because pnpm selected dogfood as affected (its dep `@ai-sdlc/plugin-mcp-server` changed) but not orchestrator (unchanged), so orchestrator's `dist/` wasn't built before dogfood tried to import from it.

AISDLC-385 PR temporarily stopgapped this by reverting the Build step in `ci.yml` to always `pnpm -r build` (no filter). The Test step still uses the filter — tests don't have the cross-package compile-order requirement.

## Acceptance criteria

- [ ] AC-1: Determine the correct pnpm filter pattern that includes foundation packages even when only their dependents changed. Options to evaluate:
  - `--filter "...[origin/main]" --filter "@ai-sdlc/orchestrator" --filter "@ai-sdlc/pipeline-cli" --filter "@ai-sdlc/reference"` (explicit always-build foundation list)
  - Pre-step that runs `pnpm --filter ...[origin/main] list --depth -1 --json`, walks deps, then builds the union
  - Switch to topological `pnpm -r --workspace-concurrency=1 build` with `--filter "...^[origin/main]"` (build dependents AND their unchanged deps)
  - Use `pnpm exec turbo run build --filter=...[origin/main]` after AISDLC-385 — wait, turbo isn't in the repo. Use pnpm only.
- [ ] AC-2: Add a hermetic test covering: changed dependent + unchanged foundation dep → filter still builds the foundation
- [ ] AC-3: Restore the filter pattern in `.github/workflows/ci.yml` Build & Test job
- [ ] AC-4: Verify the same fix on `scripts/check-coverage.sh` pre-push gate (same filter pattern used there for test:coverage)
- [ ] AC-5: Validate on 3 PR shapes: docs-only (skip), single-foundation change (full rebuild expected), single-dependent change (foundation + dependent both rebuild)

## Risks

- **Over-rebuild**: if the fix is "include foundation always", we lose most of AISDLC-389's wall-clock savings. Mitigation: track the savings; if the new pattern is no faster than `pnpm -r build`, the optimization isn't worth shipping back — just leave the stopgap.
- **Wrong-direction filter**: `...^[origin/main]` (with `^`) means "DEPENDENTS of changed packages" — that's the inverse of what we need. Need to verify the right direction.

## Estimated effort

1-2 hours of investigation + filter tuning + hermetic test.

## Out of scope

- Adopting turbo (rejected in AISDLC-389)
- Refactoring `pnpm test` to use the build-then-test pattern locally (separate concern)

## References

- AISDLC-389 — original filter introduction
- AISDLC-385 — stopgapped the Build step
- [Gate friction audit Summary §11](docs/operations/gate-friction-audit-2026.md)
