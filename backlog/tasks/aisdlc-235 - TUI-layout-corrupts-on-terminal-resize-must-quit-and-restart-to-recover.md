---
id: AISDLC-235
title: >-
  TUI layout corrupts on terminal resize — must quit and restart to recover
status: To Do
assignee: []
created_date: '2026-05-07 22:00'
labels:
  - bug
  - tui
  - rfc-0023
  - dogfood
dependencies: []
priority: medium
references:
  - pipeline-cli/src/tui/app.tsx
  - pipeline-cli/src/tui/index.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When the operator resizes their terminal window while `cli-tui` is running, the layout corrupts (panes overlap, borders draw at wrong coordinates, text wraps mid-character). The only way to recover is `q` to quit and re-launch. This is operator-hostile — most users naturally adjust window size during session work.

Witnessed empirically by operator 2026-05-07 (after Phase 6 / AISDLC-178.6 shipped):

> "If i try to change the screen layout it messes up the layout and I have to quit and restart."

The TUI is built on Ink (React-for-terminal). Ink does NOT auto-respond to terminal SIGWINCH; the app component needs to subscribe to dimension changes and force a re-render.

## Suspected root cause

Looking at the typical Ink resize-handling pattern:

```tsx
import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

function useTerminalDimensions() {
  const { stdout } = useStdout();
  const [dims, setDims] = useState({ columns: stdout.columns, rows: stdout.rows });
  useEffect(() => {
    const onResize = () => setDims({ columns: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return dims;
}
```

Ink's `App` (root component) likely doesn't listen to the `resize` event. Pane widths in `pipeline-cli/src/tui/app.tsx` are presumably computed at first render only, then frozen.

## Proposed fix

### 1. Hook-based resize subscription

Add a `useTerminalDimensions` hook in `pipeline-cli/src/tui/hooks/use-terminal-dimensions.ts` that subscribes to `process.stdout.on('resize', ...)` and exposes `{ columns, rows }`. The root `App` component consumes it and re-renders the pane grid on every change.

### 2. Pane width recompute

Most Ink components use `flexGrow` / `flexBasis` which reflow automatically on parent re-render. The bug is likely either:
- Pane widths hardcoded as integers (`width={80}`) — change to flex-based
- Border-drawing characters cached at first render and not recomputed
- Manual cursor positioning (if any) using stale dimensions

### 3. Smoke test for resize behavior

Add an `ink-testing-library` test that mounts the App, asserts initial render, then simulates a stdout resize event, and asserts the layout updated. Existing tests in `pipeline-cli/src/tui/app.test.tsx` can be extended.

## Acceptance Criteria

- [ ] #1 New `useTerminalDimensions` hook in `pipeline-cli/src/tui/hooks/use-terminal-dimensions.ts` (or equivalent) that subscribes to stdout's `resize` event and exposes current `{columns, rows}` to the React tree
- [ ] #2 Root `App` component (`pipeline-cli/src/tui/app.tsx`) consumes the hook and re-renders pane grid on every change
- [ ] #3 Pane width / height props use `flexGrow` / `flexBasis` (or `width={"50%"}`-style relative units), NOT hardcoded integer dimensions, so Ink's reflow handles the visual layout
- [ ] #4 Manual ASCII border drawing (if any) uses CURRENT dimensions, not first-render-cached ones
- [ ] #5 Smoke test in `pipeline-cli/src/tui/app.test.tsx` (or `app.resize.test.tsx`) mounts App, simulates a `process.stdout.emit('resize')` with new dimensions, asserts the rendered output includes pane content for the new size
- [ ] #6 Manual verification: launch `pnpm tui`, resize window in 4 directions (wider, narrower, taller, shorter), verify layout adapts cleanly without corruption
- [ ] #7 No regression on existing snapshot tests (use ink-testing-library's `frame` snapshot if applicable)

## Related operator feedback

The same screenshot session also surfaced (separate concerns, NOT in this task):
- `dep snapshot unavailable (source-unavailable)` — Critical Path pane shows zero data; probably `cli-deps snapshot` hasn't been run, or the snapshot writer isn't auto-fired by the orchestrator. Worth its own task once root cause is known.
- "no-reviews-yet / clean / awaiting-ci" rendered uniformly for all open PRs even though some have completed reviews — PRs pane data refresh timing or review-state inference may need work. Worth its own task.

This task focuses ONLY on the resize-corrupts-layout bug.

## References

- `pipeline-cli/src/tui/app.tsx` (root component — primary fix surface)
- `pipeline-cli/src/tui/index.ts` (TUI entry point)
- `pipeline-cli/src/tui/app.test.tsx` (existing tests — extend with resize scenario)
- Ink docs on `useStdout` hook + the `resize` event
- Operator screenshot 2026-05-07 14:55 PT — visual confirmation of TUI render
- AISDLC-178.5 (mode switching) + AISDLC-178.6 (analytics) — the most recent TUI-touching tasks
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 useTerminalDimensions hook subscribes to stdout `resize` event
- [ ] #2 Root App component consumes the hook and re-renders on dimension change
- [ ] #3 Pane sizing uses flex/relative units, not hardcoded integer dimensions
- [ ] #4 Any manual border-drawing uses current dimensions, not cached
- [ ] #5 Smoke test: simulate stdout resize, assert layout updates
- [ ] #6 Manual verification: launch pnpm tui, resize 4 directions, no corruption
- [ ] #7 No regression on existing snapshot tests
<!-- SECTION:ACCEPTANCE:END -->
