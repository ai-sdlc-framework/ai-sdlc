---
id: AISDLC-1371
title: 'cli-dor-check --task and cli-init --check print a result on success'
status: To Do
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - pipeline-cli
  - cli
dependencies: []
references:
  - pipeline-cli/src/cli/dor-check.ts
  - pipeline-cli/src/cli/dor-check.test.ts
  - pipeline-cli/src/cli/init.ts
  - pipeline-cli/src/cli/init.test.ts
priority: low
---

## Description

**Gap.** Two checks exit 0 with empty output, so an operator cannot tell a pass from a command that did nothing. Source: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2754 (item 6).

**Facts read in code** (main at 687e0d596).

- `pipeline-cli/src/cli/dor-check.ts:200-232`: the `--task` branch loops over the files and writes only when `result.blocked`; the end returns `blocked === 0 ? 0 : 1` with nothing printed on a pass. `:210-213` also returns 0 silently when no files are found. The `--staged` branch runs the same loop, and a git hook runs it on every push, so any new line must stay short.
- `pipeline-cli/src/cli/init.ts:68-88`: `--check` prints only when `missing.length > 0` (text mode) or always (JSON mode). On success the text mode prints nothing and returns 0. `--check` is also called by doctor and SessionStart.

**Observed** (from the issue, not reproduced here). Both commands exit 0 with empty stdout and stderr on a build of 04a91ceb.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the issue asks for output on success; the exit codes must not change, and callers that parse stdout (doctor, SessionStart, the pre-push hook) must not break. 2. Deleted: nothing. 3. Simplified or optimised: one line each, written to stdout in text mode only; JSON mode is untouched. 4. Accelerated: the operator reads the result at once. 5. Automated: tests assert the line and the exit code.

- `dor-check --task`: on a pass print one line, for example `[dor-gate] <task id> passes the definition of ready (<file>)`. For `--staged`, print one summary line only when at least one file was checked. Keep the blocked output as it is.
- `init --check`: in text mode on success print `ai-sdlc config is complete (nothing missing)`. Do not print it when `--notice` is used.
- Before changing, grep the callers of both commands (doctor, SessionStart hook, `.husky`) and confirm none treats empty stdout as success; fix any that does in the same change.

Out of scope: any change to the calibration log, to exit codes, or to JSON output.

## Acceptance Criteria

- [ ] #1 A test shows `cli-dor-check --task <passing task>` prints one line naming the task and exits 0.
- [ ] #2 A test shows a blocked task still prints the existing violations and exits 1, byte for byte as before.
- [ ] #3 A test shows `cli-init --check` on a complete project prints one confirmation line and exits 0, and on an incomplete one prints the existing list and exits 1.
- [ ] #4 A test shows `cli-init --check --format json` output is unchanged.
- [ ] #5 The pull request body lists the callers of both commands that were checked for reliance on empty stdout.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
