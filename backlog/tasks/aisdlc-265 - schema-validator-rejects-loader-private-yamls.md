---
id: AISDLC-265
title: Schema validator rejects loader-private YAML kinds (MaintainersList, SoulTrackMap)
status: To Do
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

- [ ] Decision made on path (extension registration vs wrapper-less convention) — captured in an RFC or decision note.
- [ ] No more `Unknown resource kind` warnings on adopter pipelines that use the standard loader-private patterns.
- [ ] Loader-private YAML files validate cleanly (or are explicitly skipped) without operator workarounds.
- [ ] `docs/operations/schema-extensions.md` (new) explains the supported pattern.
- [ ] Test coverage: validator no longer flags `MaintainersList` / `SoulTrackMap` fixtures.

## Source

Adopter session 2026-05-13, ranked #5 by friction. Forge S189 handoff has the wrapper-less convention documented.
