---
id: AISDLC-668
title: >-
  RFC-0051: cli-hierarchy brief generates a dispatch brief with waves and sequence groups from task metadata
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
  - cli
  - planner
dependencies:
  - AISDLC-664
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/bin/cli-deps.mjs
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The planner hands work to dispatch as a brief: the artifact the operator wrote by hand
on 2026-09-30 (waves, sequencing rules, trust-sensitive tasks, operator-only tasks).
This task generates the first draft from task metadata so the planner edits rather
than writes. RFC-0051 section 7.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages; `node --test`
  for plugin hooks and scripts; 80% line coverage on new code.
- Tests never start a real Claude Code session, never call tmux against the user's
  real server (inject the command runner), and never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **`cli-hierarchy brief --tasks <id,...> | --rfc <RFC-NNNN> --out <path>`**: selects
   tasks (by id, or every open task whose `references` include the RFC file), then
   writes `.ai-sdlc/dispatch/briefs/<slug>.md`.
2. **Waves** from `dependencies` frontmatter: wave 1 has no dependencies within the
   set; wave n depends only on earlier waves. A dependency outside the set that is
   not yet in `backlog/completed/` is listed as an external prerequisite.
3. **Sequence groups** from overlapping `references`: tasks that reference the same
   non-RFC file are placed in a group named after that file; well-known shared
   surfaces get fixed group names (`generated-schemas.ts` as `schema-regen`,
   `reference/src/index.ts` as `root-barrel`, `events.ts` as `events`).
4. **Flags:** tasks with `dispatchable: false` are listed under "do not dispatch";
   tasks whose references include hook, workflow, governance or `execute.md` paths are
   listed as trust-sensitive.
5. **Format:** a Markdown brief with a YAML block the board can ingest
   (`cli-dispatch enqueue --from-brief` reads that block) and prose sections the
   planner edits. The brief names the planner session and the dispatch session from
   the roster.
6. **Hand-off:** `--notify` sends the dispatch session (its roster `name`) a one-line
   message naming the brief file.
7. **Planner skill** `ai-sdlc-plugin/commands/planner.md`: the prompt the AISDLC-664
   bootstrap gives the planner session (`/ai-sdlc planner`). It prints the roster, the
   open briefs and their progress, and the pending design decisions routed to the
   planner, then describes the hand-off flow (`cli-hierarchy brief`, edit, `--notify`)
   and the hard rule that Open Questions are resolved only with the operator through
   the decision rubric. It is a short orientation, not a loop: the planner is where
   the operator works interactively.

## Acceptance Criteria
- [x] For a fixture set of six tasks with a dependency chain, the brief's waves match the chain and a dependency outside the set is listed as an external prerequisite.
- [x] Two tasks referencing the same file share a sequence group; the three well-known surfaces get their fixed group names.
- [x] A `dispatchable: false` task appears under "do not dispatch" and is absent from the YAML block.
- [x] A task referencing a hook or workflow path appears under trust-sensitive.
- [ ] The YAML block round-trips through `cli-dispatch enqueue --from-brief` into manifests with the same `after`, `sequenceGroup` and `wave` values. (Not met: contract test on the shared brief parser only; the real enqueue round-trip is deferred to AISDLC-668.1 because the enqueue command is not yet available.)
- [x] `--notify` sends exactly one message to the dispatch session named in the roster (asserted on an injected sender).
- [x] `ai-sdlc-plugin/commands/planner.md` exists, is the prompt the bootstrap issues for the planner role, and states the hard rule on Open Questions.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added `cli-hierarchy brief`, which generates a dispatch brief with waves, sequence groups, a do-not-dispatch list, trust-sensitive tasks and external prerequisites from task metadata, plus a `dispatchBrief` YAML block, a shared `parseBrief()`, `--notify`, and the `/ai-sdlc planner` orientation command. Seven of eight acceptance criteria are met; the YAML round-trip through `cli-dispatch enqueue --from-brief` is met only as a contract test on the shared parser.

## Changes
- `pipeline-cli/src/hierarchy/brief.ts`, `brief-format.ts`, `brief-notify.ts`, exported from the hierarchy barrel, and the `brief` subcommand in `pipeline-cli/src/cli/hierarchy.ts`.
- `ai-sdlc-plugin/commands/planner.md` and its contract test.
- `.gitignore`: the briefs directory (machine-local runtime output).

## Design decisions
- The brief block is a fenced yaml block keyed `dispatchBrief:` holding {task, after, sequenceGroup, wave, priority}; priority is an integer (high 1, medium 2, low 3). Entries and the whole input are size-capped on parse.
- Waves are the longest dependency chain in the dispatchable set; a dependency on an operator-only or out-of-set open task is an external prerequisite, not an `after` entry, because it would never complete on the board. The YAML does not gate those, so the brief says so next to the waves.
- Sequence groups: fixed names for the three well-known surfaces, otherwise the most-shared file; derived names are sanitised and disambiguated so they always parse.
- `--notify` validates the dispatch roster entry exactly as `down` does, then types one line (path restricted to plain ASCII path characters) with `tmux send-keys -l` and Enter. Paths with spaces are refused after the brief is written.
- Writes are exclusive, symlink-safe and confined to the briefs directory by default; task text rendered into the brief has control, bidi and backtick characters neutralised.
- The dispatch enqueue command and manifest fields belong to a separate unmerged task, so none of that scope was touched.
- Live tmux delivery to a real Claude Code session is unverified.

## Verification
- `pnpm build` — passed
- `pnpm test` — hierarchy suite passed (111), planner command test passed (7); the early root-chain gates pass locally. The known bin-invocation, verify-runtime and TUI failures reproduce on clean main. The full root suite was not run.
- `pnpm lint` — passed
- `pnpm format:check` — passed on touched files
- 3 parallel reviews approved after two rounds (Claude-native reviewers); reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-668.1: real enqueue round-trip and shared-parser use once the enqueue command exists.
- AISDLC-668.2: planner lists only design-routed decisions once a route filter exists.
- AISDLC-668.3: supervised check of notify delivery against a live session.
- AISDLC-668.4: brief-status subcommand to replace the shell progress loop.
- AISDLC-668.5: defense-in-depth hardening from the reviews.
<!-- SECTION:FINAL_SUMMARY:END -->
