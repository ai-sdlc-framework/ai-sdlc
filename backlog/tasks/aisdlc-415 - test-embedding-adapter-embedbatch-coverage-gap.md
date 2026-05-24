---
id: AISDLC-415
title: 'test(embedding): close embedBatch coverage gap (AISDLC-337 follow-up)'
status: To Do
labels: [test, embedding, follow-up-aisdlc-337]
dependencies:
  - AISDLC-337
references: []
priority: high
permittedExternalPaths: []
blocked:
  reason: "Referenced files (openai-text-embedding-3-small.ts, embedding.test.ts) ship via AISDLC-337 PR #650 — references will resolve after that merges. This task is the follow-up to fix the embedBatch coverage gap flagged by code-reviewer."
---

## Description

AISDLC-337 shipped the RFC-0019 Phase 1 embedding adapter framework. The test-reviewer flagged a MAJOR coverage gap on the `embedBatch()` method (lines 183-247 of openai-text-embedding-3-small.ts) — 0% coverage on a 65-line public method dragged patch coverage to 76.35%, below the 80% gate.

The fix is mechanical: add 7 test cases covering the missing surfaces.

## Acceptance criteria

- [ ] AC-1: test for `embedBatch([])` — empty-array fast-path returns immediately
- [ ] AC-2: test for `embedBatch(['valid', ''])` — empty-string-in-batch rejection
- [ ] AC-3: test for `embedBatch(['x'])` with no `OPENAI_API_KEY` env var — guard fires
- [ ] AC-4: test for successful multi-text batch (mock fetch, assert correct request body + parsed response)
- [ ] AC-5: test for batch HTTP error (4xx/5xx) — throws `EmbeddingProviderError`
- [ ] AC-6: test for batch dimension-mismatch — throws appropriate error
- [ ] AC-7: test for `consumerLabel` propagation via `embedBatch()` (mirror the AC-equivalent for `embed()`)
- [ ] AC-8: coverage on `openai-text-embedding-3-small.ts` reaches ≥80% after these additions
- [ ] AC-9: also add the operator-asked-for `setCostCallback()` test (one test: instantiate without callback, call setCostCallback, verify records flow afterward)

## Out of scope

- Phase 2+ embedding work
- Refactoring the adapter's batching logic
- Other adapters

## Estimated effort

20-40 min. Pure test additions; no production code changes.
