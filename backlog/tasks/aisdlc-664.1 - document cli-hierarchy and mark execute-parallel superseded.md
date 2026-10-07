---
id: AISDLC-664.1
title: >-
  RFC-0051: cli-hierarchy reference page in operations docs and mark execute-parallel as superseded
status: To Do
assignee: []
created_date: '2026-09-30'
updated_date: '2026-10-06'
labels:
  - rfc-0051
  - dispatch
  - docs
dependencies:
  - AISDLC-664
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/hierarchy/
  - pipeline-cli/bin/cli-hierarchy.mjs
  - docs/operations/parallel-dispatch.md
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`cli-hierarchy` has no documentation page. On 2026-10-06 the operator asked where its documentation was; the only prose is a partial section in `docs/operations/parallel-dispatch.md` (from line 242, covering `up`, `status`, `attach` and `down`) and the tool's own `--help`. Since this task was first filed the command grew to eleven subcommands (`up`, `status`, `attach`, `terminals`, `brief`, `down`, `clear`, `tick`, `route-decision`, `check-sender`, `check-repo`) and the `up` options `--executors`, `--planner-model`, `--dispatch-model`, `--executor-model`, `--no-planner`, `--project`, `--attach`, `--allow-planner-bypass`. The original scope (three subcommands in the parallel-dispatch runbook) no longer fits.

Write a dedicated reference page `docs/operations/cli-hierarchy.md` and link it from `docs/operations/README.md` and from the parallel-dispatch runbook. Source of truth is the help text and source under `pipeline-cli/src/hierarchy/`; the page must agree with both (add a parity test, or extend an existing docs check, that fails when a subcommand or option exists in the CLI but not on the page).

The page covers:
- Purpose and the roles: planner, dispatch session, executors; one tmux session per agent; project-qualified session names (`<project>-<role>`) and when `--project` is required.
- Every subcommand with synopsis, options, what it changes on disk (roster file location and shape, hierarchy.json, dispatch board directories), exit codes, and an example. `up` includes the settings preflight, the `--no-planner` roster consequence (the planner is then not a roster member and dispatch reports only to roster planners), and the restart rule (sessions pick up a new plugin version only after `down` + `up`).
- The operating cycle: `brief` to `tick` to `clear`, with the self-clear rule (one task per executor context, dispatch clears itself each tick) and how `clear` interacts with an executor's loop.
- Troubleshooting: `up` refusing over a stale roster, `attach` with an unknown name, sessions for another project colliding, and how to read `status --json`.
- Mark `/ai-sdlc execute-parallel` as superseded by `cli-hierarchy` at the top of `docs/operations/parallel-dispatch.md` and in the command's own description, pointing to the new page, as RFC-0051 specifies.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `docs/operations/cli-hierarchy.md` exists, is linked from `docs/operations/README.md` and from `parallel-dispatch.md`, and documents every subcommand and `up` option listed by `cli-hierarchy --help` on main at the time of the change.
- [ ] A parity test or docs check fails when the CLI gains a subcommand or option the page does not mention.
- [ ] The page states the roster file location and shape, the `--no-planner` consequence for reporting, and the restart rule for plugin upgrades.
- [ ] `/ai-sdlc execute-parallel` is marked superseded with a pointer to the new page in both the runbook and the command description.
- [ ] `pnpm docs:check`, `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass, apart from the 14 pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), which the PR body discloses.
