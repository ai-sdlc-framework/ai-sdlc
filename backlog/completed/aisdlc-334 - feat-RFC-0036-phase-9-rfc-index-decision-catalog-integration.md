---
id: AISDLC-334
title: 'feat: RFC-0036 Phase 9 — `ai-sdlc rfc index` integration with RFC-0035 Decision Catalog'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-9
dependencies:
  - AISDLC-328
  - AISDLC-285
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: medium
blocked:
  reason: 'RFC-0036 + RFC-0035 lifecycle=Ready for Review acknowledged; all RFC-0036 OQs resolved 2026-05-16; RFC-0035 already shipped Phase 1 (AISDLC-285). Phase 9 implementation does not modify either RFC.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 9 of RFC-0036 §13. `ai-sdlc rfc index` lists adopter RFCs + cross-references them against the RFC-0035 Decision Catalog so adopters can see "which decisions does this RFC resolve."

## Scope

- `ai-sdlc rfc index` CLI scans `<adopter-repo>/<rfcDir>/*.md` + emits a table of (RFC, status, decisions-resolved, decisions-pending).
- Reads RFC-0035 Decision Catalog event log (`.ai-sdlc/_decisions/events.jsonl`) for the decisions-resolved column.
- Depends on RFC-0035 Phase 1 (AISDLC-285) — Decision schema + cli-decisions.
- Output format: human-readable table + `--json` for programmatic consumption.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc rfc index` CLI scans `<rfcDir>/*.md`
- [x] #2 Cross-references each RFC against RFC-0035 Decision Catalog event log
- [x] #3 Output columns: RFC ID, title, lifecycle, decisions-resolved count, decisions-pending count
- [x] #4 `--json` output for programmatic consumption
- [x] #5 Composes with RFC-0035 Phase 1 (AISDLC-285) Decision schema
<!-- AC:END -->

## Final Summary

### Summary

Shipped `cli-rfc index` — a new pipeline-cli subcommand that lists adopter RFCs from `<adopter-repo>/<rfcDir>/*.md` (default `rfcs/`, falls back to `spec/rfcs/`, respects `.ai-sdlc/adopter-authoring.yaml rfc-scaffold.rfcDir`) and cross-references each against the RFC-0035 Decision Catalog event log to surface per-RFC counts of resolved + pending decisions.

### Changes

- `pipeline-cli/src/cli/rfc.ts` (new): yargs router + pure helpers (`resolveRfcDir`, `buildRfcIndex`, `renderIndexTable`, `extractRfcIdFromFilename`, `extractRfcIdFromScope`, `extractRfcTitle`, `groupDecisionsByRfc`).
- `pipeline-cli/src/cli/rfc.test.ts` (new): 29 hermetic tests covering all pure helpers, config resolution, decision cross-reference math, and the full yargs surface (text + json modes, fallbacks, degrade-open when the Decision Catalog flag is off).
- `pipeline-cli/bin/cli-rfc.mjs` (new): bin shim forwarding to `dist/cli/rfc.js`.
- `pipeline-cli/package.json`: registered `cli-rfc` in the `bin:` map.
- `pipeline-cli/src/import-spec/config.ts`: extended `AdopterAuthoringConfig` with `rfcScaffold.rfcDir` (RFC-0036 §14.1 `rfc-scaffold:` slice) — agreed key with the still-pending AISDLC-327 (Phase 2 `rfc init`) so neither phase blocks the other.
- `pipeline-cli/src/import-spec/config.test.ts`: 4 new tests covering the `rfc-scaffold` slice (default, nested form, flat form, fallback on empty).

### Design decisions

- **`assumes:` vs `requires:`**: AISDLC-334 lists AISDLC-328 + AISDLC-285 as dependencies. Phase 1 (AISDLC-285 — Decision schema + cli-decisions) is shipped + the `listDecisions` / `projectDecision` API is what Phase 9 consumes. Phase 5 concurrency hardening (AISDLC-328) doesn't gate Phase 9 — `cli-rfc index` is a read-only consumer of the event log.
- **Decision ↔ RFC cross-reference via `metadata.scope`**: Decision records carry a free-form `scope` field. Phase 9 groups decisions by the `RFC-NNNN` id embedded in scope (`rfc:RFC-NNNN` or bare `RFC-NNNN`). Resolved/pending split uses RFC-0035 lifecycle vocab: `answered`, `superseded`, `archived` → resolved; `proposed`, `open`, `deferred` → pending.
- **Phase 2 not yet shipped**: AISDLC-327 (`rfc init` CLI) is still in `backlog/tasks/`. Phase 9 doesn't wait on Phase 2 — the `cli-rfc` yargs program is structured so adding `init` later is additive. The `adopter-authoring.yaml rfc-scaffold.rfcDir` config slice was extended early so both phases agree on the same key.
- **Dogfood-repo fallback to `spec/rfcs/`**: when the adopter default `rfcs/` doesn't exist BUT `spec/rfcs/` does, the resolver uses the framework convention. Lets the dogfood repo run `cli-rfc index` without per-repo config — useful for self-testing.
- **Degrade-open when Decision Catalog flag is off**: mirrors the `cli-decisions` convention. Read paths still list RFCs (counts = 0) with a stderr note explaining why; no hard error.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 5263 passed | 1 skipped (275 files)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Smoke: `node pipeline-cli/bin/cli-rfc.mjs index --format json` against the dogfood repo emits the framework RFC list with `rfcDirSource: spec-rfcs-fallback` and zero decision counts (catalog is empty in dogfood).

### Follow-up

None. Phase 2 (AISDLC-327) ships `rfc init` on the same config surface; Phase 10 + 11 are unrelated.
