---
id: AISDLC-389
title: 'chore: pnpm affected-package filter for pre-push coverage + CI Build & Test'
status: Done
labels:
  - performance
  - hooks
  - ci
references:
  - scripts/check-coverage.sh
  - .github/workflows/ci.yml
  - pnpm-workspace.yaml
  - scripts/is-docs-only-changeset.mjs
  - docs/operations/gate-friction-audit-2026.md
parentTaskId: AISDLC-384
---

## Description

Surfaced by the AISDLC-384 gate-friction audit — combined verdict for pre-push Gate 1 (`check-coverage.sh`) and CI Gate "Build & Test (Node 22)". Both gates currently run the FULL workspace (`pnpm -r build` + `pnpm -r test` / `pnpm -r test:coverage`) regardless of which packages the push actually changed. On a 5-line bash-script PR, this is ~4 minutes of CI wall-clock + ~5 minutes of local pre-push time spent re-validating untouched packages.

Both gates can use the same fix: pnpm's native affected-package filter (`--filter "...[origin/main]"`) scoped to changes since main. pnpm 6+ walks the dep graph from changed files using `pnpm-workspace.yaml` + each package's `package.json` `dependencies`. No new tooling required (the repo does not use turbo).

This is a SINGLE task because the filter logic + invocation pattern is shared. Splitting into two would mean re-deriving the same `--filter "...[origin/main]"` pattern in two places.

## Acceptance criteria

### Pre-push Gate 1 (Option A + B from audit)
- [ ] AC-1: `scripts/check-coverage.sh` calls `scripts/is-docs-only-changeset.mjs` FIRST; if changeset is docs-only, exit 0 silently with `[coverage-gate] docs-only changeset — skipping` log (Option B).
- [ ] AC-2: For non-docs-only, replace `pnpm -r build` with `pnpm --filter "...[origin/main]" build` (Option A).
- [ ] AC-3: Replace `pnpm -r test:coverage` with `pnpm --filter "...[origin/main]" test:coverage`.
- [ ] AC-4: Coverage threshold-walk only opens `coverage-summary.json` for packages pnpm's filter actually built (parse pnpm output or `pnpm --filter "...[origin/main]" --depth -1 list --json` to derive the package list).
- [ ] AC-5: Existing escape hatches preserved (`AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_COVERAGE_GATE=1`).
- [ ] AC-6: Hermetic test at `scripts/check-coverage.test.mjs` covers: docs-only push (skips), single-package push (only that package's coverage walked), cross-cutting push (all packages walked).

### CI Build & Test
- [ ] AC-7: `.github/workflows/ci.yml` Build & Test job's `pnpm build` step replaced with `pnpm --filter "...[origin/main]" build`.
- [ ] AC-8: `pnpm test` step replaced with `pnpm --filter "...[origin/main]" test`.
- [ ] AC-9: `pnpm validate-schemas` step preserved (always runs — it's cheap + cross-cutting).
- [ ] AC-10: `merge_group` event: pnpm's `...[origin/main]` may not resolve correctly on merge_group refs. Detect event_name in workflow + fall back to full run on `merge_group` (acceptable since merge_group is rare and final validation).

### Cross-cutting
- [ ] AC-11: Update `docs/operations/gate-friction-audit-2026.md` Gate 1 + CI Gate 1 sections — mark verdict as shipped via AISDLC-389.
- [ ] AC-12: Validate end-to-end on three PR shapes:
  - Docs-only PR → pre-push coverage skips; CI Build & Test runs minimal (or skips if AISDLC-388 ships first)
  - Single-package change (e.g. only `pipeline-cli/src/foo.ts`) → only pipeline-cli + its dependents build/test
  - Cross-cutting change (e.g. `schemas/` or `package.json`) → full workspace runs

## Estimated effort

1 day implementation + 1 day validation. Mostly small bash + YAML edits.

## Risks + mitigations

- **Filter misses transitive consumers**: if a package's `package.json` deps aren't accurate, pnpm's filter could skip dependent tests. Mitigation: existing CI Codecov gate is the safety net for coverage; for tests, run a one-time validation comparing pnpm-filtered vs full runs on 5 historical PRs to verify no false negatives. If a regression is found, audit + fix the missing dep declarations (the real bug, not the filter).
- **merge_group event base**: pnpm's `...[origin/main]` may not resolve correctly on merge_group refs. Mitigation: detect event_name in workflow + fall back to full run when `merge_group` (acceptable since merge_group is rare and final validation).
- **Coverage threshold-walk for cross-cutting only**: if pnpm runs all packages, the threshold-walk still checks all `coverage-summary.json` files. Mitigation: behavior unchanged from today on cross-cutting; only optimized on partial.
- **pnpm filter syntax brittleness**: the `...[origin/main]` syntax requires git-aware pnpm + correct main ref availability. Mitigation: hermetic test covers no-main-ref case + fallback path.

## Out of scope

- Docs-only short-circuit at CI Build & Test workflow level (folded into AISDLC-388's pr-ready archetype routing — that's the cleaner architectural fix)
- Parallel matrix-split of tests (different optimization vector; revisit if AISDLC-389's savings aren't enough)
- Refactoring `pnpm test` itself to use a different runner (out of scope — keep `pnpm test` as today's full-run path for local dev)
- Introducing turbo or another monorepo orchestrator (overkill; pnpm's native filter is sufficient)

## References

- [Gate friction audit Gate 1 (pre-push)](docs/operations/gate-friction-audit-2026.md#gate-1) — Option A+B verdict
- [Gate friction audit CI Gate 1 (Build & Test)](docs/operations/gate-friction-audit-2026.md#ci-gate-1) — same conclusion
- AISDLC-368 — prior CI optimization (Node 20 drop); this builds on it
- AISDLC-388 — sibling architectural fix (docs-only routing)
