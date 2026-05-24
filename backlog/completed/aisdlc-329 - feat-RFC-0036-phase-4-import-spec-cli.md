---
id: AISDLC-329
title: 'feat: RFC-0036 Phase 4 — `ai-sdlc import-spec --from <path>` CLI (no reconcile yet)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-4
dependencies:
  - AISDLC-328
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: high
blocked:
  reason: 'RFC-0036 lifecycle is Ready for Review; all 12 §14 OQs resolved via operator walkthrough 2026-05-16 (RFC §14 header) — implementation phases AISDLC-326..336 cleared to proceed.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0036 §13. Initial import CLI that translates spec-kit `tasks.md` into backlog tasks with `specRef:` back-references.

## Scope

- `ai-sdlc import-spec --from <path>` CLI + `/ai-sdlc import-spec --from <path>` slash command (OQ-12 dual-surface).
- Read spec-kit `tasks.md` only (per OQ-1: no fallback to spec.md).
- For each task entry: create backlog task with `specRef:` pointing back to the spec-kit `tasks.md` row.
- Schema versioning: auto-detect spec-kit version; refuse unknown (per OQ-11).
- Read `.ai-sdlc/adopter-authoring.yaml` for config; default `artifactGranularity: tasks-md-only`.
- **No reconcile yet** — drift handling is Phase 6.
- **No DoR yet** — DoR-at-import is Phase 5.
- Missing `tasks.md` → emit `Decision: incomplete-spec-detected` via Decision Catalog stub (full catalog wires in RFC-0035 Phase 1; for v1 of this task, log to events.jsonl and emit upstream clarification task).
- Unknown schema → emit `Decision: upstream-schema-unknown` (same routing).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc import-spec --from <path>` CLI + slash command ship
- [x] #2 Reads `tasks.md` only; missing file emits `Decision: incomplete-spec-detected` + upstream clarification task
- [x] #3 Schema auto-detect; unknown emits `Decision: upstream-schema-unknown` + upgrade-framework task
- [x] #4 Each imported task carries `specRef:` back-reference
- [x] #5 Reads `adopter-authoring.yaml import.*` config
- [x] #6 No reconcile / drift handling (Phase 6 scope)
- [x] #7 Integration test: full spec-kit project → import → backlog tasks created with correct specRefs
<!-- AC:END -->

## Implementation Summary

Shipped a new `cli-import-spec` CLI + matching `/ai-sdlc import-spec` slash command (dual-surface per OQ-12) that translates spec-kit `tasks.md` into backlog tasks with `specRef:` back-references. Two failure modes (missing `tasks.md`, unknown spec-kit schema) route through RFC-0035's Decision Catalog and produce upstream-clarification tasks in the backlog — non-blocking per G0.

### New files

- `pipeline-cli/src/import-spec/parser.ts` — spec-kit `tasks.md` parser supporting both v0.8 heading (`### T-NNN — title`) and v0.7 checkbox layouts; returns `schemaVersion: 'unknown'` for unrecognised input.
- `pipeline-cli/src/import-spec/config.ts` — reader for `.ai-sdlc/adopter-authoring.yaml` `import.*` slice with §14.1 defaults (`tasks-md-only`, strict, refuse-emit-clarification).
- `pipeline-cli/src/import-spec/task-writer.ts` — writes backlog task files with `specRef:` frontmatter, monotonic `IMP-N` id allocation, AISDLC-234 slug + filename conventions.
- `pipeline-cli/src/import-spec/decisions.ts` — emits `decision-opened` events for `incomplete-spec-detected` + `upstream-schema-unknown`, paired with `IMPCLARIFY-N` clarification tasks routed back to the operator.
- `pipeline-cli/src/import-spec/import.ts` — top-level `importSpec()` orchestrator.
- `pipeline-cli/src/cli/import-spec.ts` — yargs CLI router with text + JSON output modes.
- `pipeline-cli/bin/cli-import-spec.mjs` — bin shim.
- `ai-sdlc-plugin/commands/import-spec.md` — `/ai-sdlc import-spec` slash command.

Tests live next to each source file with the full end-to-end loop covered in `import.test.ts` against a temp-dir spec-kit fixture (AC #7).

### Deferred (out of scope per task body)

- **DoR at import time** — Phase 5 (AISDLC-330).
- **Reconcile / drift handling** — Phase 6 (AISDLC-331).
- **`specRef:` JSON schema in `spec/schemas/`** — Phase 3 (AISDLC-328). Backlog tasks accept arbitrary frontmatter today; the Phase 4 `specRef:` shape matches RFC-0036 §9.1 verbatim and is forward-compatible with the eventual schema.
