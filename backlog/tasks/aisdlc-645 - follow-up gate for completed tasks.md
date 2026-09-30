---
id: AISDLC-645
title: >-
  RFC-0049 section 9.5: follow-ups in a completed task must cite a filed task, say none, or be explicitly declined
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - capability-liveness
  - backlog
  - hooks
  - plugin
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts
  - scripts/check-dor-gate.sh
  - scripts/check-task-moved.sh
  - CLAUDE.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The direct cause of the unwired seams: a completed task's Final Summary said, under
Follow-up, that the orchestrator should inject a model adapter, and no task was ever
filed for it. Nothing reads that section. This task makes a follow-up either a tracked
item or an explicit refusal. RFC-0049 section 9.5.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`, section 9. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, 80% line coverage on new code.
  Scripts under `scripts/` use `node --test`.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **Rule.** In a task file under `backlog/completed/`, find the `### Follow-up`
   heading inside the Final Summary. The section passes when it is absent, when its
   only content is `(none)`, or when every list item or non-empty paragraph does one
   of: cites a tracked-work id (a backlog task id in this project's prefix-hyphen-number
   form, or a GitHub issue reference written as a hash and a number, optionally
   prefixed with owner and repository), or starts with `declined:` followed by a
   reason of at least ten characters.
2. **Script** `scripts/check-followups.mjs` with `--task <path>` and
   `--staged --push-range <A..B>` modes, mirroring the argument shape of the DoR gate
   (`scripts/check-dor-gate.sh`). In range mode it checks only task files that are
   added to or modified under `backlog/completed/` within the range, so tasks completed
   before this gate are not re-checked. Output names the file, quotes each offending
   item, and shows the three accepted forms.
3. **Pre-push wiring:** run the script in `.husky/pre-push` after the DoR gate and
   before the fixups orchestrator. It blocks the push on a violation. Skip variable
   `AI_SDLC_SKIP_FOLLOWUP_GATE=1`, honoured the same way as the other per-gate skips,
   and the master bypass variable is respected.
4. **Plugin tool:** `ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts` applies the
   same rule to the `finalSummary` it is given and rejects the call with the same
   message, before moving the file. Share one implementation of the rule between the
   script and the tool.
5. **Tests:** `scripts/check-followups.test.mjs` with `node --test`, wired into the
   root `pnpm test` as `test:followup-gate`.
6. **CLAUDE.md:** in the existing `finalSummary` template, change the `## Follow-up`
   line to state the three accepted forms. Edit that line in place; add no new section.

## Acceptance Criteria
- [ ] A Follow-up section reading `(none)`, a section where every item cites a task id or issue reference, and a missing section all pass.
- [ ] An item with free prose and no id fails, and the output quotes the item and lists the accepted forms.
- [ ] An item starting with `declined:` and a reason passes; `declined:` with no reason fails.
- [ ] In range mode, a completed task file outside the push range with a prose follow-up is not reported.
- [ ] The pre-push hook blocks a push that adds a completed task with a prose follow-up, and passes with `AI_SDLC_SKIP_FOLLOWUP_GATE=1`.
- [ ] The `task_complete` tool rejects a `finalSummary` with a prose follow-up, leaves the task file where it was, and accepts the same summary once the item cites a task id.
- [ ] The script and the tool use one shared rule implementation (no duplicated regex).
- [ ] `pnpm test:followup-gate` exists and is part of the root `pnpm test`.
- [ ] The `finalSummary` template in CLAUDE.md states the three accepted forms on its existing Follow-up line.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
