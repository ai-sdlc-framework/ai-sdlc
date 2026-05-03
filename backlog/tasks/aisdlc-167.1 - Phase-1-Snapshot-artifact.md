---
id: AISDLC-167.1
title: 'Phase 1: Snapshot artifact'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - phase-1
  - snapshot
  - cli-deps
milestone: m-3
dependencies: []
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0014. Emit a graph snapshot artifact at `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` per pipeline tick using AISDLC-117's in-memory graph computer. The snapshot becomes the canonical input for Phase 2 (PPA composition), Phase 3 (DoR composition), and Phase 4 (digest rendering). Estimated 0.5 week.

## In-flight cross-reference

**AISDLC-166 is doing this work in flight** — the developer was dispatched directly against AISDLC-166 before this sub-task tree was created. When AISDLC-166's PR merges, it satisfies this sub-task. **Action when 166 merges:** close AISDLC-167.1 (move to `backlog/completed/`) with a note pointing back to AISDLC-166's PR/SHA in the final summary. No re-implementation here — this task exists for tree-completeness so the parent (AISDLC-167) has the canonical 5-phase decomposition.

## Open-question resolutions implemented in this phase

- **Q2 (retention):** Snapshot writer accepts `tag: 'rolling' | 'dispatch' | 'calibration' | 'lifecycle-transition'`. Rolling-tagged snapshots are trimmed by mtime > 30d via a new `cli-deps gc` command. Event-tagged snapshots are kept indefinitely; `cli-deps inspect --tag <name>` enumerates them so an operator can audit/prune the permanent tier.
- **Q3 (external deps):** Snapshot renders each task's `externalDependencies:` frontmatter array (entries: `{ id, description, kind, resolverHint? }`) per task line. Pure signal in v1; not a dispatch gate.
- **Q6 (consistency):** Per-task atomic `readFile` + sequential walk; "best-effort consistency, validated by consumer" contract documented in `pipeline-cli/docs/deps.md`. Dangling edges are caught downstream by `cli-deps validate`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Snapshot writer emits `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` per pipeline tick, one JSONL line per task with fields `{id, status, dependsOn, unblocks, depth, reach}` per RFC §4.1
- [ ] #2 `depth` (longest chain from a graph root) and `reach` (transitive closure of `unblocks`) computed in O(V+E) per snapshot
- [ ] #3 Snapshot validates against a JSON schema published under `spec/schemas/deps-snapshot.v1.schema.json`; readable + parseable by Phase 2/3/4 consumers
- [ ] #4 Q2 retention: snapshot writer accepts `tag: 'rolling' | 'dispatch' | 'calibration' | 'lifecycle-transition'`; `cli-deps gc` trims rolling > 30d mtime; `cli-deps inspect --tag <name>` enumerates event-tagged snapshots
- [ ] #5 Q3 external deps: per-task `externalDependencies:` frontmatter array (entries `{ id, description, kind: 'npm-version'|'github-pr'|'url-head'|'manual'|'other', resolverHint? }`) is parsed and rendered into the snapshot per task
- [ ] #6 Q6 consistency contract: per-task atomic `readFile` + sequential walk implementation; documented in `pipeline-cli/docs/deps.md` ("best-effort consistency, validated by consumer")
- [ ] #7 Hermetic tests cover snapshot fields, tag-based retention, external-deps rendering, and dangling-edge tolerance (validated downstream, NOT during write)
- [ ] #8 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
