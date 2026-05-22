---
id: AISDLC-389
title: 'chore: turbo affected-package filter for pre-push coverage + CI Build & Test'
status: To Do
labels:
  - performance
  - hooks
  - ci
references:
  - scripts/check-coverage.sh
  - .github/workflows/ci.yml
  - turbo.json
  - scripts/is-docs-only-changeset.mjs
  - docs/operations/gate-friction-audit-2026.md
parentTaskId: AISDLC-384
---

## Description

Surfaced by the AISDLC-384 gate-friction audit — combined verdict for pre-push Gate 1 (`check-coverage.sh`) and CI Gate "Build & Test (Node 22)". Both gates currently run the FULL workspace (`pnpm -r build` + `pnpm -r test` / `pnpm -r test:coverage`) regardless of which packages the push actually changed. On a 5-line bash-script PR, this is ~4 minutes of CI wall-clock + ~5 minutes of local pre-push time spent re-validating untouched packages.

Both gates can use the same fix: a turbo affected-package filter scoped to `origin/main..HEAD`. The repo already has `turbo.json` declaring the dependency graph; we just don't use the filter feature.

This is a SINGLE task because the filter logic + invocation pattern is shared. Splitting into two would mean re-deriving the same `--filter=...[origin/main]` pattern in two places.

## Acceptance criteria

### Pre-push Gate 1 (Option A + B from audit)
- [ ] AC-1: `scripts/check-coverage.sh` calls `scripts/is-docs-only-changeset.mjs` FIRST; if changeset is docs-only, exit 0 silently with `[coverage-gate] docs-only changeset — skipping` log (Option B).
- [ ] AC-2: For non-docs-only, replace `pnpm -r build` with `turbo run build --filter=...[origin/main]` (Option A).
- [ ] AC-3: Replace `pnpm -r test:coverage` with `turbo run test:coverage --filter=...[origin/main]`.
- [ ] AC-4: Coverage threshold-walk only opens `coverage-summary.json` for packages turbo actually touched (use turbo's output to derive the list).
- [ ] AC-5: Existing escape hatches preserved (`AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_COVERAGE_GATE=1`).
- [ ] AC-6: Hermetic test at `scripts/check-coverage.test.mjs` covers: docs-only push (skips), single-package push (only that package's coverage walked), cross-cutting push (all packages walked).

### CI Build & Test
- [ ] AC-7: `.github/workflows/ci.yml` Build & Test job's `pnpm build` step replaced with `turbo run build --filter=...[origin/main]`.
- [ ] AC-8: `pnpm test` step replaced with `turbo run test --filter=...[origin/main]`.
- [ ] AC-9: `pnpm validate-schemas` step preserved (always runs — it's cheap + cross-cutting).
- [ ] AC-10: `merge_group` event: filter should compare against the queue's base, not main (verify turbo handles this correctly; if not, fall back to full run on merge_group).

### Cross-cutting
- [ ] AC-11: Update `docs/operations/gate-friction-audit-2026.md` Gate 1 + CI Gate 1 sections — mark verdict as shipped via AISDLC-389.
- [ ] AC-12: Validate end-to-end on three PR shapes:
  - Docs-only PR → pre-push coverage skips; CI Build & Test runs minimal (or skips if AISDLC-388 ships first)
  - Single-package change (e.g. only `pipeline-cli/src/foo.ts`) → only pipeline-cli + its dependents build/test
  - Cross-cutting change (e.g. `schemas/` or `package.json`) → full workspace runs

## Estimated effort

1 day implementation + 1 day validation. Mostly small bash + YAML edits.

## Risks + mitigations

- **Turbo filter misses transitive consumers**: if a package's `package.json` deps aren't accurate, the filter could skip dependent tests. Mitigation: existing CI Codecov gate is the safety net for coverage; for tests, run a one-time validation comparing turbo-filtered vs full runs on 5 historical PRs to verify no false negatives. If a regression is found, add to the "always run" list.
- **merge_group event base**: turbo's `[origin/main]` may not resolve correctly on merge_group refs. Mitigation: detect event_name in workflow + fall back to full run when `merge_group` (acceptable since merge_group is rare and final validation).
- **Coverage threshold-walk for cross-cutting only**: if turbo runs all packages, the threshold-walk still checks all `coverage-summary.json` files. Mitigation: behavior unchanged from today on cross-cutting; only optimized on partial.

## Out of scope

- Docs-only short-circuit at CI Build & Test workflow level (folded into AISDLC-388's pr-ready archetype routing — that's the cleaner architectural fix)
- Parallel matrix-split of tests (different optimization vector; revisit if AISDLC-389's savings aren't enough)
- Refactoring `pnpm test` itself to use turbo natively (out of scope — keep `pnpm test` as today's full-run path for local dev)

## References

- [Gate friction audit Gate 1 (pre-push)](docs/operations/gate-friction-audit-2026.md#gate-1) — Option A+B verdict
- [Gate friction audit CI Gate 1 (Build & Test)](docs/operations/gate-friction-audit-2026.md#ci-gate-1) — same conclusion
- AISDLC-368 — prior CI optimization (Node 20 drop); this builds on it
- AISDLC-388 — sibling architectural fix (docs-only routing)
