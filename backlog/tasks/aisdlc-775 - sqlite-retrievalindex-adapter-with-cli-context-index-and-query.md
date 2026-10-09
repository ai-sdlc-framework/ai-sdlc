---
id: AISDLC-775
title: >-
  sqlite RetrievalIndex adapter with cli-context index and query
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-1
dependencies:
  - AISDLC-773
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - orchestrator/src/embedding/index.ts
  - orchestrator/src/embedding/pipeline-load.ts
  - orchestrator/package.json
  - pipeline-cli/src/cli/index.ts
priority: high
dispatchable: true
blocked:
  reason: "RFC-0053 OQ-4 to OQ-8 open; phase 1 depends only on OQ-1 to OQ-3, resolved 2026-10-09 by operator rubric"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the retrieval layer default from RFC-0053 OQ-2. Define a `RetrievalIndex` interface and a SQLite implementation: an FTS5 table (BM25) for keyword search, a vector table fed through the RFC-0019 embedding provider adapter, and an edges table for typed relations queried with recursive CTEs. Fuse keyword and vector results with reciprocal rank fusion. The index file lives under `.ai-sdlc/` at `retrieval.indexPath` and is gitignored; the entries on disk stay the source of truth. `cli-context index` rebuilds the file from the entries. `cli-context query --budget N --min-score S --session <id>` returns ids, contentHash and citations, ranked and trimmed to the token budget. An adapter registry declares `enterprise` as a known kind that is not implemented and fails closed with a clear message. `better-sqlite3` is already a dependency of `orchestrator/package.json`.

Sequencing: depends on the knowledge store task (AISDLC-773) in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `RetrievalIndex` interface and SQLite implementation exist with FTS5, vector and edges tables (test).
- [ ] `cli-context index` rebuilds the index from entries on disk; deleting the index file and rebuilding returns identical query results (test).
- [ ] Keyword and vector results are fused with reciprocal rank fusion; a fixture shows a document found by only one signal still ranks (test).
- [ ] `cli-context query` returns entry ids, contentHash and citations, honors `--budget` and `--min-score`, and prefers the head of a `supersedes` chain (test).
- [ ] `cli-context query --session <id>` omits entries already recorded as loaded for that session unless the contentHash changed (test).
- [ ] A benchmark test shows p95 query latency under 200 ms at 10K entries.
- [ ] The index path is gitignored and `retrieval.adapter` and `retrieval.indexPath` are read from `.ai-sdlc/context.yaml` (test).
- [ ] Selecting `retrieval.adapter: enterprise` exits non-zero with a message that the adapter is declared but not implemented (test).
