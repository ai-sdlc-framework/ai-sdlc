---
id: AISDLC-1
title: Add Backlog.md adapter as IssueTracker implementation
status: Done
assignee: []
created_date: '2026-03-08 22:27'
updated_date: '2026-03-08 22:47'
labels:
  - adapter
  - integration
  - backlog-md
dependencies: []
references:
  - reference/src/adapters/interfaces.ts
  - reference/src/adapters/linear/index.ts
  - reference/src/adapters/github/index.ts
  - reference/src/adapters/jira/index.ts
  - reference/src/adapters/registry.ts
  - reference/src/adapters/scanner.ts
  - mcp-advisor/src/issue-linker.ts
  - docs/tutorials/04-custom-adapter.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement a Backlog.md adapter that conforms to the `IssueTracker` interface contract, allowing ai-sdlc to use Backlog.md as a native issue tracking backend alongside GitHub Issues, Linear, and Jira.

## Context

AI-SDLC supports pluggable issue trackers via the adapter pattern (AdapterBinding resources). Existing implementations include GitHub (`reference/src/adapters/github/`), Linear (`reference/src/adapters/linear/`), and Jira (`reference/src/adapters/jira/`). Backlog.md is a markdown-file-based task manager that uses the `backlog` CLI and MCP server — it's local-first with no external API, which makes this adapter unique compared to the HTTP-based ones.

## Key Differences from Existing Adapters

- **Local filesystem** — tasks are markdown files in `backlog/tasks/`, not HTTP API resources
- **CLI-based** — operations go through `backlog` CLI or the MCP server tools
- **No authentication** — no secretRef needed (local files)
- **Task IDs** — use `task-NNN` format instead of numeric IDs
- **No webhooks** — `watchIssues()` would use filesystem watching or polling

## Implementation

### New Files
- `reference/src/adapters/backlog-md/index.ts` — adapter implementation
- `reference/src/adapters/backlog-md/metadata.yaml` — adapter metadata
- `reference/src/adapters/backlog-md/index.test.ts` — tests

### IssueTracker Interface Mapping

| Method | Backlog.md Implementation |
|--------|--------------------------|
| `listIssues(filter)` | Read task files from `backlog/tasks/`, parse frontmatter, filter by status/labels |
| `getIssue(id)` | Read `backlog/tasks/{id}.md`, parse frontmatter + body |
| `createIssue(input)` | Write new task markdown file via `backlog` CLI or direct file creation |
| `updateIssue(id, input)` | Update frontmatter/body in existing task file |
| `transitionIssue(id, transition)` | Update `status` field in frontmatter |
| `addComment(id, body)` | Append to implementation notes section |
| `getComments(id)` | Parse implementation notes section |
| `watchIssues(filter)` | fs.watch on `backlog/tasks/` directory |

### AdapterBinding Config
```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: backlog-md-adapter
spec:
  interface: IssueTracker
  type: backlog-md
  version: 0.1.0
  config:
    backlogDir: ./backlog    # path to backlog directory
    taskPrefix: task         # task ID prefix
```

### Adapter Metadata
```yaml
name: backlog-md
displayName: "Backlog.md Issue Tracker"
description: "Local-first markdown-based issue tracker adapter"
version: "0.1.0"
stability: alpha
interfaces:
  - IssueTracker@v1
owner: "@ai-sdlc-framework"
specVersions: ["v1alpha1"]
```

### Integration Points
- Update `mcp-advisor/src/issue-linker.ts` to resolve Backlog.md task IDs (e.g. `task-42` branch → issue 42)
- Register adapter in `reference/src/adapters/index.ts` barrel exports
- Add to orchestrator's `createPipelineAdapterRegistry()` built-in stubs
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Backlog.md adapter implements full IssueTracker interface (listIssues, getIssue, createIssue, updateIssue, transitionIssue, addComment, getComments, watchIssues)
- [x] #2 Adapter reads/writes task markdown files with correct frontmatter parsing
- [x] #3 metadata.yaml passes adapter schema validation
- [x] #4 AdapterBinding YAML example works with config validation
- [x] #5 issue-linker resolves task-NNN branch names to Backlog.md task IDs
- [x] #6 Adapter is registered in the adapter registry and discoverable via scanLocalAdapters
- [x] #7 Tests cover all IssueTracker methods using temp directories with fixture task files
- [x] #8 Adapter handles missing backlog directory gracefully (clear error message)
<!-- AC:END -->
