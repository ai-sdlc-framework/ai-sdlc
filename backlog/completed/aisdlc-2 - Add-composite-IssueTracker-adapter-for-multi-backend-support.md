---
id: AISDLC-2
title: Add composite IssueTracker adapter for multi-backend support
status: Done
assignee: []
created_date: '2026-03-08 23:06'
updated_date: '2026-03-08 23:17'
labels:
  - adapter
  - integration
  - composite
dependencies: []
references:
  - reference/src/adapters/interfaces.ts
  - reference/src/adapters/registry.ts
  - reference/src/adapters/backlog-md/index.ts
  - reference/src/adapters/jira/index.ts
  - orchestrator/src/adapters.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement a composite/multiplexer IssueTracker adapter that delegates to multiple backends simultaneously (e.g., GitHub Issues + Backlog.md).

## Context

The adapter registry already supports registering multiple IssueTracker adapters, and `registry.list('IssueTracker')` returns all of them. However, the pipeline resolves a single adapter by name — there's no built-in fan-out that merges results from multiple backends.

## Design

A thin `createCompositeIssueTracker(trackers: IssueTracker[])` that:

- **`listIssues`** — fans out to all backends in parallel, merges results
- **`getIssue`** — routes by ID prefix (e.g., `PROJ-1` → Backlog.md, `#42` → GitHub)
- **`createIssue`** — routes to a configured primary backend
- **`updateIssue` / `transitionIssue`** — routes by ID prefix
- **`addComment` / `getComments`** — routes by ID prefix
- **`watchIssues`** — merges event streams from all backends

### ID Routing

Each backend registers with a prefix pattern (e.g., `AISDLC-*` for Backlog.md, numeric for GitHub). The composite adapter uses these patterns to route mutations to the correct backend.

### Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: composite-issue-tracker
spec:
  interface: IssueTracker
  type: composite
  config:
    primary: backlog-md
    backends:
      - name: backlog-md
        prefix: "AISDLC"
      - name: github
        prefix: "#"
```

## Files

- `reference/src/adapters/composite-issue-tracker.ts` — implementation
- `reference/src/adapters/composite-issue-tracker.test.ts` — tests
- Update `reference/src/adapters/index.ts` — barrel exports
- Update `orchestrator/src/adapters.ts` — registry + re-exports
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Composite adapter implements full IssueTracker interface
- [ ] #2 listIssues fans out to all backends and merges results
- [ ] #3 Mutations route to correct backend by ID prefix pattern
- [ ] #4 createIssue routes to configured primary backend
- [ ] #5 watchIssues merges event streams from all backends
- [ ] #6 Tests cover routing, fan-out, and error handling
- [ ] #7 Registered in adapter registry and barrel exports
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Implemented a composite `IssueTracker` adapter that wraps N child backends behind a single `IssueTracker` interface, routing by ID prefix.

### Files Created
- `reference/src/adapters/composite-issue-tracker.ts` — Core implementation with prefix-based routing, fan-out `listIssues`, and merged `watchIssues` via `WebhookBridge`
- `reference/src/adapters/composite-issue-tracker.test.ts` — 15 tests covering all methods, routing, fan-out, partial failure, and stream merging

### Files Modified
- `reference/src/adapters/index.ts` — Added barrel exports for `createCompositeIssueTracker`, `CompositeIssueTrackerConfig`, `BackendRoute`
- `orchestrator/src/adapters.ts` — Added re-exports for composite adapter types and factory

### Verification
- All 15 tests pass
- `reference/` and `orchestrator/` build cleanly
<!-- SECTION:FINAL_SUMMARY:END -->
