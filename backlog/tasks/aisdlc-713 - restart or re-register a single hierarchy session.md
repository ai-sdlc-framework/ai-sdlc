---
id: AISDLC-713
title: >-
  Restart or re-register a single hierarchy session
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - hierarchy
dependencies: []
references:
  - pipeline-cli/bin/cli-hierarchy.mjs
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`cli-hierarchy` (`pipeline-cli/src/cli/hierarchy.ts`) can only restart sessions through `down`
plus `up`, which restarts the whole hierarchy including the dispatch session and kills
in-flight work. Refreshing one executor (for a new plugin build, or after a crash) therefore
needs a full stop. Restarting a session by hand changes its pid, which the roster and the
caller binding check.

## Acceptance Criteria
- [ ] `cli-hierarchy restart <session>` stops and starts one named session and updates its roster entry (pid, started time) atomically; other sessions are untouched.
- [ ] `cli-hierarchy register <session>` re-registers an already-running session whose pid changed, verifying the tmux pane and process before writing.
- [ ] Refuses when the session holds a claimed task unless `--after-task` is given, which waits for the task boundary; the refusal names that flag.
- [ ] The dispatch session can run both for executors; an executor cannot run them for other sessions (same role rules as the existing hierarchy commands); refusal messages name the next step.
- [ ] Tests with a fixture roster; docs updated; PR body carries a "Velocity impact" section.

## Out of scope
- Changing how `up` builds the hierarchy.
<!-- SECTION:DESCRIPTION:END -->
