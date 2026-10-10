---
id: AISDLC-791.1
title: >-
  cli-hierarchy status reports every session as env-missing: hasLaunchEnv fails on tmux's quoted pane_start_command
status: To Do
assignee: []
created_date: '2026-10-10'
updated_date: '2026-10-10'
labels:
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
### Context

AISDLC-791 (#1330) added the ENV column to `cli-hierarchy status`. On 2026-10-10 23:10Z, with every session launched by the fixed `up` (`pane_start_command` verified to carry `AI_SDLC_HIERARCHY_SESSION=... AI_SDLC_HIERARCHY_ROLE=...`, and `ps -E` showing both vars on the claude processes), status printed `env missing on <name>: relaunch with ...` for ALL seven rows.

Cause: `tmux display-message -p '#{pane_start_command}'` returns the command wrapped in double quotes (`"AI_SDLC_HIERARCHY_SESSION='ai-sdlc-executor-alpha' ...`), and `hasLaunchEnv` in `pipeline-cli/src/hierarchy/up.ts` anchors each key on `(?:^|\s)`, so the leading `"` defeats the first match.

A false "missing" is dangerous: dispatch reads status and the next-step text tells it to `down --role executor`, which would return every inflight manifest to the queue and churn five running tasks.

### Five-step review

1. Requirement questioned: the ENV column (AISDLC-791 item 2) exists to catch sessions left over from a pre-791 build, which `up` now refuses to start. Keep it only because sessions outlive builds.
2. Delete: the `nextStep` relaunch instruction must not be printed when the probe itself is unreliable. Remove the instruction text from the row and keep a one-word column; nothing else to delete.
3. Simplify: strip one layer of surrounding double quotes from the `pane_start_command` before matching, or match on `(?:^|\s|")`. One regex change.
4. Accelerate / 5. Automate: none.

### Fix

In `hasLaunchEnv`, unwrap a leading/trailing `"` pair before matching. Add a test in `pipeline-cli/src/hierarchy/hierarchy.test.ts` with the exact quoted string tmux returns (quoted and unquoted value forms). Add a test that `formatStatus` shows `ok` for such a row. Keep the `up` refusal (up.ts ~line 362) unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `hasLaunchEnv('"AI_SDLC_HIERARCHY_SESSION=\'x\' AI_SDLC_HIERARCHY_ROLE=\'executor\' \'claude\' ..."', 'x', 'executor')` is true.
- [ ] #2 The unquoted planner form (`"AI_SDLC_HIERARCHY_SESSION=ai-sdlc-planner AI_SDLC_HIERARCHY_ROLE=planner claude ..."`) is true.
- [ ] #3 A bare `"claude --name x"` is still reported as `missing`.
- [ ] #4 `cli-hierarchy status` on the live hierarchy shows `ok` for every row launched by `up`.
- [ ] #5 The hermetic status test covers the quoted form.
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
