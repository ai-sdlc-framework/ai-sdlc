---
id: AISDLC-4
title: Add formatIssueRef and issueIdToNumber unit tests
status: To Do
assignee: []
created_date: '2026-03-09 01:42'
labels:
  - testing
dependencies: []
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add unit tests for the `formatIssueRef` and `issueIdToNumber` helper functions in `orchestrator/src/shared.ts`.

## Acceptance Criteria
<!-- AC:BEGIN -->
- formatIssueRef returns `#42` for numeric IDs and `AISDLC-3` for string IDs
- issueIdToNumber returns the number for numeric strings, null for non-numeric
- extractIssueId parses branch names correctly

### Complexity
1
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 formatIssueRef returns #N for numeric and bare ID for non-numeric
- [ ] #2 issueIdToNumber returns number or null correctly
- [ ] #3 extractIssueId parses ai-sdlc/issue-<id> branches
<!-- AC:END -->
