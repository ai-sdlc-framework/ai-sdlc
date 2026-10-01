---
id: AISDLC-668.5
title: >-
  RFC-0051: harden dispatch brief generation against minor review findings
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
dependencies:
  - AISDLC-668
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/hierarchy/brief.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Defense-in-depth items from the reviews of brief generation. (1) The backlog priority lookup uses a plain object, so a priority such as constructor crashes generation; use an own-property lookup. (2) Rendered text escapes backticks but not backslashes and misses some invisible Unicode marks (U+200B to U+200F, U+061C, U+FEFF). (3) The brief fence matcher can run in quadratic time within the size cap; use a line-based scanner. (4) A fresh write with an explicit output path is not confined to the repo and the path is announced to the dispatch session; confine it or apply the briefs-directory check to both paths, and realpath-check the briefs directory after creating it. (5) Task ids from frontmatter are not validated when selecting by RFC. (6) The exclusive write ignores the byte count returned by the write call.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A task with priority constructor generates a brief without crashing, in a test.
- [ ] A title with a backslash before a backtick and invisible marks renders without opening a code span, in a test.
- [ ] A brief of many unclosed fence openers parses in linear time, in a test.
- [ ] An explicit output path outside the repo is refused or checked the same as the default path.
- [ ] A malformed task id found by RFC selection is skipped with a warning.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
