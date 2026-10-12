---
id: AISDLC-819
title: >-
  TUI ink render tests time out on a slow operator machine: raise the timeout for src/tui tests or remove the slow render
status: Done
assignee: []
created_date: '2026-10-11'
labels:
  - pipeline
  - fix
  - tui
dependencies: []
references:
  - pipeline-cli/vitest.config.ts
  - pipeline-cli/src/tui/app.test.tsx
  - pipeline-cli/src/tui/use-terminal-dimensions.test.tsx
priority: critical
dispatchable: true
---

## Description

Filed under the DEC-0127 drain exception (a new PR only to fix an existing PR: #1413 and the bucket-A resumes).

`pipeline-cli/src/tui/app.test.tsx` and `pipeline-cli/src/tui/use-terminal-dimensions.test.tsx` time out at vitest's default 5 s on the operator machine (macOS, Node 22.23.2) in any shell (tmux unset, CI=1), observed since the 2026-10-11 02:45Z parent `pnpm install`. They are not broken: with `--testTimeout=60000` all pass (36 s for 5 tests, about 7 s per ink render). CI passes them at the default timeout. Consequence: every `/ai-sdlc execute` resume on this machine reports `test=failed` and the executor cannot sign. AISDLC-812 (PR #1413) failed twice on it, and every PR-drain resume is blocked behind it.

**Five-step review (requirements first).**
1. Requirement questioned: the 5 s per-test timeout is vitest's default, set by nobody in this repo; a render-heavy ink test has no reason to inherit a unit-test timeout.
2. Delete: nothing to delete; the tests themselves are the regression net for the AISDLC-764 / RFC-0023 TUI.
3. Simplify: one scoped timeout for `src/tui/**/*.test.tsx` (vitest `test.timeout` per file via `vi.setConfig({ testTimeout })` or a `describe` options object), not a global raise.
4. Accelerate: if the root cause of the 7 s render is found (for example a dev-dependency mismatch after install, an ink raw-mode wait, or a fake timer not installed), remove it so the tests run fast everywhere.
5. Automate: none.

Velocity impact: positive; unblocks every executor resume on the operator machine and AISDLC-812.

## Acceptance Criteria

- [ ] AC-1: `pnpm --filter @ai-sdlc/pipeline-cli test` passes on the operator machine with no flags, including the two TUI test files.
- [ ] AC-2: The timeout change (if any) is scoped to `src/tui/**/*.test.tsx`; the default for every other test is unchanged.
- [ ] AC-3: The PR body records the measured per-render time before and after and names the cause if found; if the slow render is environmental, say what in the environment causes it.
- [ ] AC-4: CI run time for the pipeline-cli suite does not grow (no added sleeps or retries).
- [ ] AC-5: If the cause was found and fixed, a regression guard exists (a test or lint) that fails if the render goes back above a few hundred milliseconds in CI.

## Notes

Related: AISDLC-812 (#1413), AISDLC-814 (#1416, env-dependent tests), the planned known-environment-failure list (not yet filed) (candidate entry if purely environmental).
