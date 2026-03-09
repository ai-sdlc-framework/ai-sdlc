---
id: AISDLC-4
title: Add formatIssueRef and issueIdToNumber unit tests
status: Done
assignee: []
created_date: '2026-03-09 01:42'
updated_date: '2026-03-09 02:23'
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

- [x] #1 formatIssueRef returns #N for numeric and bare ID for non-numeric
- [x] #2 issueIdToNumber returns number or null correctly
- [x] #3 extractIssueId parses ai-sdlc/issue-<id> branches
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
### Note (2026-03-09 01:43)

## AI-SDLC: PR Created

Pull request: https://github.com/ai-sdlc-framework/ai-sdlc/pull/24
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Completed via pipeline run. Unit tests for `formatIssueRef`, `issueIdToNumber`, and `extractIssueId` added. Merged as part of PR #24.
<!-- SECTION:FINAL_SUMMARY:END -->
