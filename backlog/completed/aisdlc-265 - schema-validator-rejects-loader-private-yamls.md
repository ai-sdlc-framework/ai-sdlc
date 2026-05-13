---
id: AISDLC-265
title: Schema validator rejects loader-private YAML kinds (MaintainersList, SoulTrackMap)
status: Done
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - schema
  - ppa
  - rfc-0008
dependencies: []
priority: medium
references:
  - spec/schemas
---

## Bug

The schema validator emits `Unknown resource kind` warnings for YAML files using loader-private kinds like `MaintainersList` and `SoulTrackMap`, even though `loadMaintainers()` and `loadSoulTracks()` (in the adopter's PPA wrapper) read these files happily.

The current behavior is noisy: every adopter pipeline run emits a warning per loader-private file, drowning out real schema problems.

## Two paths forward (pick in design)

1. **Register the schemas**: add `MaintainersList` + `SoulTrackMap` (and any other adopter-extension kinds) to the canonical schema registry so the validator recognizes them. Requires deciding whether AI-SDLC ships these schemas itself or accepts an adopter-extension registration mechanism.
2. **Document wrapper-less convention**: declare that loader-private YAMLs MUST omit the `apiVersion: ai-sdlc/v1` + `kind:` wrapper (or use a different leader pattern). Validator skips files without the wrapper.

The forge S189 handoff already describes the wrapper-less convention. If we go with option 2, codify it; if option 1, add an extension mechanism.

## Acceptance criteria

- [x] Decision made on path (extension registration vs wrapper-less convention) — captured in an RFC or decision note.
- [x] No more `Unknown resource kind` warnings on adopter pipelines that use the standard loader-private patterns.
- [x] Loader-private YAML files validate cleanly (or are explicitly skipped) without operator workarounds.
- [x] `docs/operations/schema-extensions.md` (new) explains the supported pattern.
- [x] Test coverage: validator no longer flags `MaintainersList` / `SoulTrackMap` fixtures.

## Source

Adopter session 2026-05-13, ranked #5 by friction. Forge S189 handoff has the wrapper-less convention documented.

## Final Summary

## Summary

Path 2 (wrapper-less convention + graceful skip) was chosen. `validateResource` now returns `{ valid: true, skipped: true }` for any `kind` not in the AI-SDLC schema registry, instead of a false-positive `Unknown resource kind` error. The orchestrator's `validateConfigFiles` and `config.ts` admission loader both handle `result.skipped` by silently continuing, so no warning is emitted for adopter-extension kinds like `MaintainersList` or `SoulTrackMap`.

## Changes

- `reference/src/core/validation.ts` (modified): Added `skipped?: boolean` to `ValidationResult`, changed `validateResource` to return `{ valid: true, skipped: true }` for unknown kinds instead of an error.
- `reference/src/core/validation.test.ts` (modified): Updated the "rejects unknown kind" test to assert `valid: true, skipped: true`; added `MaintainersList` and `SoulTrackMap` fixture tests.
- `orchestrator/src/validate-config.ts` (modified): Added `result.skipped` guard to skip loader-private files silently from `validateConfigFiles`.
- `orchestrator/src/validate-config.test.ts` (modified): Added 3 tests for skipped loader-private kinds.
- `orchestrator/src/config.ts` (modified): Added `result.skipped` guard before the `result.valid` check in the admission config loader.
- `docs/operations/schema-extensions.md` (new): Decision note + adopter consumption pattern documentation.

## Design decisions

- **Path 2 (wrapper-less convention + graceful skip)**: Avoids the overhead of schema governance for adopter-private YAML formats. Extension registry (Path 1) would require versioning and schema maintenance for every adopter-specific shape. Graceful skip is zero-config, forward-compatible, and matches the Forge S189 handoff convention.
- **`valid: true` not `valid: false`**: Skipped files pass validation from the caller's perspective — they are not schema violations. Callers that need to distinguish can inspect `result.skipped`.

## Verification

- `pnpm build` — clean (reference, orchestrator, pipeline-cli)
- `pnpm test` — 20 reference tests + 3102 orchestrator tests pass
- `pnpm lint` — clean (0 errors)
- `pnpm format:check` — clean

## Follow-up

(none)
