---
id: AISDLC-166
title: 'RFC-0014 Phase 1: deps snapshot artifact + GC + externalDependencies'
status: Done
assignee: []
created_date: '2026-05-02 10:00'
labels:
  - deps
  - rfc-0014
  - phase-1
dependencies:
  - AISDLC-117
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/docs/deps.md
  - docs/operations/deps-composition.md
  - spec/schemas/deps-snapshot.v1.schema.json
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0014 Phase 1 (§11): the snapshot artifact foundation that the depth-aware
priority + DoR blast-radius + Slack digest layers (Phases 2-4) all consume.

Ships behind feature flag `AI_SDLC_DEPS_COMPOSITION` (default OFF per §9).

### What lands

1. **Snapshot writer** (`pipeline-cli/src/deps/snapshot.ts`):
   - `writeSnapshot(tag, opts)` writes
     `$ARTIFACTS_DIR/_deps/snapshot.<isoTimestamp>.<tag>.jsonl`.
   - One JSONL line per task: `{ id, dependencies, dependents, depth,
     criticalPathLength, externalDependencies, lastModified }`.
   - Reuses AISDLC-117's existing graph computer
     (`pipeline-cli/src/deps/dependency-graph.ts`).

2. **Schema** (`spec/schemas/deps-snapshot.v1.schema.json`).

3. **`cli-deps snapshot --tag <name>`** subcommand — writes a snapshot now,
   prints absolute path + record count. Default tag `rolling`.

4. **`cli-deps gc`** subcommand — trims rolling-tagged snapshots older than
   30 days; preserves event-tagged forever (RFC-0014 §12 Q2).

5. **`cli-deps inspect --tag <name>`** subcommand — lists snapshots with
   the given tag, sorted by embedded ISO timestamp.

6. **`externalDependencies:` frontmatter** (RFC-0014 §8 + Q3) — task files
   may declare an array of `{id, description, kind, resolverHint?}`
   entries; the snapshot serialises them. Pure signal in v1.

7. **Tests** — 24 hermetic tests in
   `pipeline-cli/src/deps/snapshot.test.ts` plus 7 router smoke tests in
   `pipeline-cli/src/cli/deps.test.ts`. Schema validates against the real
   on-disk artifact.

8. **Docs** — `pipeline-cli/docs/deps.md` (CLI surface + record semantics +
   the "best-effort consistency, validated by consumer" Q6 contract) and
   `docs/operations/deps-composition.md` (operator runbook for the flag).

9. **CLAUDE.md** — feature-flag entry under a new "Feature flags" section.

### Out of scope (later phases)

- Phase 2 (PPA composition / `effectivePriority` sort).
- Phase 3 (DoR blast-radius comment template).
- Phase 4 (Slack digest + dashboard graph view).
- Phase 5 (corpus-driven flag promotion).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Snapshot writer at `pipeline-cli/src/deps/snapshot.ts` emits JSONL with `{id, dependencies, dependents, depth, criticalPathLength, externalDependencies, lastModified}` per record.
- [x] #2 JSON Schema at `spec/schemas/deps-snapshot.v1.schema.json` validates the record shape (and validates against the real on-disk artifact in tests).
- [x] #3 `cli-deps snapshot --tag <name>` writes a snapshot to `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl` and prints absolute path + record count.
- [x] #4 `cli-deps gc` trims rolling-tagged snapshots older than 30 days by mtime; preserves event-tagged snapshots regardless of age.
- [x] #5 `cli-deps inspect --tag <name>` lists snapshots with the given tag sorted by embedded ISO timestamp.
- [x] #6 Feature flag `AI_SDLC_DEPS_COMPOSITION` gates the writer (default OFF; truthy values = `1`/`true`/`yes`/`on`, case-insensitive).
- [x] #7 `externalDependencies:` frontmatter (array of `{id, description, kind, resolverHint?}`) is parsed and serialised into the snapshot; all 5 enum values supported.
- [x] #8 Snapshot survives mid-walk file deletion per the RFC-0014 Q6 "best-effort consistency, validated by consumer" contract.
- [x] #9 GC preserves zero-byte rolling files under the age cap without crashing.
- [x] #10 Documentation in `pipeline-cli/docs/deps.md` covers the consistency contract, the schema, the CLI workflow, and the feature flag; operator runbook in `docs/operations/deps-composition.md` covers enable/disable/observability.
- [x] #11 CLAUDE.md gains a "Feature flags" section documenting `AI_SDLC_DEPS_COMPOSITION`.
- [x] #12 Pre-flight is clean: `pnpm --filter @ai-sdlc/pipeline-cli build && test && lint && format:check`.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINALSUMMARY:BEGIN -->
## Summary
RFC-0014 Phase 1 ships the dependency-graph snapshot artifact behind feature
flag `AI_SDLC_DEPS_COMPOSITION` — the foundation downstream PPA / DoR / Slack
composition layers (Phases 2-4) read from. Writer + GC + inspect subcommands
land on the existing `cli-deps` router; `externalDependencies:` frontmatter
gives tasks a structured way to declare out-of-graph blockers.

## Changes
- `pipeline-cli/src/deps/snapshot.ts` (new): writer + GC + inspect + flag helper + record computer.
- `pipeline-cli/src/deps/dependency-graph.ts` (modified): adds `ExternalDependency` type, `externalDependencies` + `lastModified` on `DependencyNode`, `parseExternalDependenciesBlock` parser.
- `pipeline-cli/src/deps/snapshot.test.ts` (new): 24 hermetic tests covering depth/CPL math, externalDependencies enum, schema validation, GC age cutoffs + zero-byte preservation, inspect filtering, flag-OFF no-op, mid-walk consistency.
- `pipeline-cli/src/cli/deps.ts` (modified): `snapshot`, `gc`, `inspect` subcommands wired into the existing yargs router.
- `pipeline-cli/src/cli/deps.test.ts` (modified): 7 new smoke tests for the router-side wiring.
- `pipeline-cli/src/deps/index.ts` (modified): re-export snapshot module.
- `pipeline-cli/package.json` (modified): adds `ajv` devDependency for schema-validation tests.
- `spec/schemas/deps-snapshot.v1.schema.json` (new): JSON Schema 2020-12.
- `pipeline-cli/docs/deps.md` (new): CLI surface + record semantics + Q6 consistency contract.
- `docs/operations/deps-composition.md` (new): operator runbook for the flag.
- `CLAUDE.md` (modified): adds "Feature flags" section documenting `AI_SDLC_DEPS_COMPOSITION`.
- `backlog/completed/aisdlc-166 - ...md` (new): this task file.

## Design decisions
- **Inline parser for `externalDependencies:`** rather than overhauling the shared `parseSimpleYaml` (which is used by every step in the pipeline). The parser sits in `dependency-graph.ts` next to the only consumer; if other frontmatter keys ever need nested-object support, that's the natural moment to lift it.
- **No write barrier** per RFC-0014 §12 Q6 — the writer follows the "best-effort consistency, validated by consumer" contract. A test deliberately deletes a task file mid-walk to prove the snapshot is internally consistent and the consumer (`cli-deps validate`) catches the dangling edge.
- **Cycle-safe DFS for depth + criticalPathLength**: the writer is downstream of `validate`, but it must not infinite-loop if the operator runs `snapshot` against a graph with an unfixed cycle. Re-entry into a node already on the recursion stack short-circuits to 0; `validate` flags the cycle separately.
- **Filenames replace `:` with `-`** so snapshots are NTFS-friendly. The embedded timestamp is still lexically sortable in calendar order, which is what `inspect`'s sort relies on.
- **`isCompositionEnabled` is strict-truthy** — only `1`/`true`/`yes`/`on` (case-insensitive) flip the flag. Anything else (typos, half-set values) is treated as off so a misconfiguration can't silently enable composition.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1121/1121 pass (24 new in snapshot.test.ts, 7 new in deps.test.ts)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm --filter @ai-sdlc/reference validate-schemas` — `deps-snapshot.v1.schema.json` validates
- End-to-end smoke: `AI_SDLC_DEPS_COMPOSITION=1 cli-deps snapshot --tag rolling` produced a 192-record JSONL artifact against the live backlog.

## Follow-up
- Phase 2 (RFC-0014 §5): PPA dispatcher integration — `effectivePriority` sort using `criticalPathLength` as the secondary tiebreak.
- Phase 3 (RFC-0014 §6): DoR comment template extension — blast-radius callout (standard) + bypass-FYI variant.
- Phase 4 (RFC-0014 §7): Slack digest + dashboard graph view.
- Phase 5 (RFC-0014 §11): corpus-driven soak window + flag promotion.
<!-- SECTION:FINALSUMMARY:END -->
