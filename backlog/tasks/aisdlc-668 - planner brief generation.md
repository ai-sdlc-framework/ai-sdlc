---
id: AISDLC-668
title: >-
  RFC-0051: cli-hierarchy brief generates a dispatch brief with waves and sequence groups from task metadata
status: To Do
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
6. **Hand-off:** `--notify` sends `operator-dispatch` a one-line message naming the
   brief file.

## Acceptance Criteria
- [ ] For a fixture set of six tasks with a dependency chain, the brief's waves match the chain and a dependency outside the set is listed as an external prerequisite.
- [ ] Two tasks referencing the same file share a sequence group; the three well-known surfaces get their fixed group names.
- [ ] A `dispatchable: false` task appears under "do not dispatch" and is absent from the YAML block.
- [ ] A task referencing a hook or workflow path appears under trust-sensitive.
- [ ] The YAML block round-trips through `cli-dispatch enqueue --from-brief` into manifests with the same `after`, `sequenceGroup` and `wave` values.
- [ ] `--notify` sends exactly one message to the dispatch session named in the roster (asserted on an injected sender).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
