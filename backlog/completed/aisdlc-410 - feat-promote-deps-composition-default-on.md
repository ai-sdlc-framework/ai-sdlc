---
id: AISDLC-410
title: 'feat(deps): promote AI_SDLC_DEPS_COMPOSITION to default-ON (RFC-0014 Phase 5)'
status: Done
labels: [deps, rfc-0014, promotion, operator-merge]
references:
  - pipeline-cli/src/deps/snapshot.ts
  - docs/operations/deps-composition-promotion.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
priority: high
permittedExternalPaths: []
---

## Description

Per operator directive 2026-05-23: promote `AI_SDLC_DEPS_COMPOSITION` (RFC-0014) from default-OFF to default-ON. RFC-0014 Phases 1-5 are implemented but gated; Phase 5 includes the corpus aggregator + operator-override capture + this promotion runbook. The operator's directive constitutes the **override-path** evidence per `docs/operations/deps-composition-promotion.md` (the corpus path is documented as needing ≥30 snapshots; operator judgment is the alternative).

Follow Option A from the runbook ("flip the default in the parser") — invert the polarity of `isCompositionEnabled` so absent env = ON, opt-out via `AI_SDLC_DEPS_COMPOSITION=off` (or `0`/`false`/`no` case-insensitively); truthy values (`1`/`true`/`yes`/`on`) are honored for backward-compat.

## Acceptance criteria

- [x] AC-1: Flip default in `pipeline-cli/src/deps/snapshot.ts#isCompositionEnabled` — invert polarity so unset env = ON.
- [x] AC-2: Audit every caller branching on the flag — confirmed callers via `isCompositionEnabled()` in `pipeline-cli/src/cli/decisions.ts`, `pipeline-cli/src/dor/slack-digest.ts`, `pipeline-cli/src/dor/comment-loop.ts` all consume the boolean directly; no caller relies on the OFF-by-default polarity in a way that breaks under default-ON.
- [x] AC-3: Update CLAUDE.md "AI_SDLC_DEPS_COMPOSITION" bullet — "Off by default" → "On by default since AISDLC-410; opt out via `AI_SDLC_DEPS_COMPOSITION=off`."
- [x] AC-4: Updated `pipeline-cli/src/deps/snapshot.test.ts` to reflect the new default-ON polarity (3 cases: unset/random = ON, opt-out values = OFF, truthy backward-compat).
- [x] AC-5: Updated `pipeline-cli/src/dor/slack-digest.test.ts shouldIncludeCriticalPath` test (line 248: unset → ON post-cutover).

## Out of scope

- Closing RFC-0014 parent task ACs (separate task).
- `docs/operations/deps-composition.md` + `pipeline-cli/docs/deps.md` doc framing updates — deferred to follow-up so this PR stays scoped to the parser flip + tests.

## Estimated effort

30-45 min.
