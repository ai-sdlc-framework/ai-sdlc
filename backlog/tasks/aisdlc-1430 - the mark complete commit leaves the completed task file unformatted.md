---
id: AISDLC-1430
title: "The `mark <id> complete` commit leaves `backlog/completed/<id>.md` unformatted and fails format checks on adopter PRs"
status: To Do
priority: medium
labels:
  - pipeline-cli
  - backlog
  - bug
dependencies: []
references:
  - pipeline-cli/src/steps/10-finalize.ts
  - pipeline-cli/src/steps/10-finalize.test.ts
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/task-done.ts
  - pipeline-cli/src/next-step/task-done.test.ts
  - .prettierignore
---

## Description

**Five-step review (requirements first).**
1. Question: reported by the ai-sdlc-enterprise planner on 2026-11-26. An adopter whose `format:check` covers `backlog/` fails on the file the `chore: mark <id> complete` commit moves into `backlog/completed/` (this repo hides it: `.prettierignore` has `*.md`). Verified cause: `buildFinalSummary` (`pipeline-cli/src/steps/10-finalize.ts:132-139`) emits headings with no blank line after them (`## Summary\n<text>`, `## Changes\n<files>`, and so on) and puts the reviews line directly after the verification list items with no blank line. `renderDoneTask` writes that text into the task under `## Final Summary` (`next-step/task-done.ts:96-106`, `setFinalSummary` `:65-84`), and `markTaskDone` is what `next-step/ship.ts:447-459` calls before the `git commit` of `choreCommitMessage` (`ship.ts:474-490`). I ran prettier 3.9 with default config on a sample of this shape: it inserts a blank line after each heading and indents the reviews line as a list continuation, so `prettier --check` fails. Step 10 (`10-finalize.ts:190-260`, the other `chore: mark <id> complete` site at `:254`) only patches the frontmatter status and moves the file; it does not write `finalSummary` into the file, so there the move leaves the source bytes as they were. No formatter runs on either path.
2. Delete: nothing.
3. Simplify: planner decision: fix `buildFinalSummary` so its output is prettier-stable (a blank line after each heading, and a blank line between the verification list and the reviews line), cover both mark-complete commit sites (`ship.ts` and `10-finalize.ts`), and test with `prettier --check` (default config) on the generated completed file. No formatter run is added to the commit path. Existing tests that assert the exact summary text change only for the added blank lines.
4. Accelerate: none.
5. Automate: the prettier-check test (AC #2 and #3).

## Acceptance Criteria
- [ ] #1 `buildFinalSummary` output has a blank line after every heading and between the verification list and the reviews line, and nothing else changes in its content.
- [ ] #2 A test builds a prettier-clean task file, runs it through the `ship.ts` completion path (`renderDoneTask` / `markTaskDone` with `buildFinalSummary` output), and asserts `prettier --check` (default config, run programmatically or via the repo's prettier) passes on `backlog/completed/<id>.md`. It fails on main.
- [ ] #3 A Step 10 test does the same for `10-finalize.ts`, for both the default path and `useAtomicCompletion`.
- [ ] #4 No prettier or other formatter call is added to either commit path.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
