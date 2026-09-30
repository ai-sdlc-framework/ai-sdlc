---
id: AISDLC-645
title: >-
  RFC-0049 section 9.5: follow-ups in a completed task must cite a filed task, say none, or be explicitly declined
status: Done
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
- [x] A Follow-up section reading `(none)`, a section where every item cites a task id or issue reference, and a missing section all pass.
- [x] An item with free prose and no id fails, and the output quotes the item and lists the accepted forms.
- [x] An item starting with `declined:` and a reason passes; `declined:` with no reason fails.
- [x] In range mode, a completed task file outside the push range with a prose follow-up is not reported.
- [x] The pre-push hook blocks a push that adds a completed task with a prose follow-up, and passes with `AI_SDLC_SKIP_FOLLOWUP_GATE=1`.
- [x] The `task_complete` tool rejects a `finalSummary` with a prose follow-up, leaves the task file where it was, and accepts the same summary once the item cites a task id.
- [x] The script and the tool use one shared rule implementation (no duplicated regex).
- [x] `pnpm test:followup-gate` exists and is part of the root `pnpm test`.
- [x] The `finalSummary` template in CLAUDE.md states the three accepted forms on its existing Follow-up line.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
One shared follow-up rule now serves both the pre-push gate and the `task_complete` tool. A completed task's `Follow-up` section passes when it is absent, reads `(none)`, or every item cites a task id or issue reference or starts with `declined:` plus a reason of at least ten characters.

## Changes
- `pipeline-cli/src/backlog/followup-rule.ts` (new, exported from the barrel): the single rule implementation, with bounded regexes and fail-closed handling of oversized lines.
- `scripts/check-followups.mjs`: `--task <path>` and `--staged --push-range A..B` modes; range mode checks only completed task files added or modified in the range, read from the range tip.
- `scripts/check-followups-on-push.sh` and `.husky/pre-push`: one added line after the DoR gate and before the fixups orchestrator; `AI_SDLC_SKIP_FOLLOWUP_GATE=1` and the master bypass honoured; fails closed on script error.
- `ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts`: rejects a bad `finalSummary` before any write or move.
- `package.json`: `test:followup-gate`, part of the root `pnpm test`.
- `CLAUDE.md`: the existing `## Follow-up` line in the finalSummary template now states the three accepted forms.
- Tests: rule unit tests (35), gate tests (14), task_complete tests.

## Design decisions
- The rule lives in pipeline-cli so the plugin tool and the script share it; the script loads it from pipeline-cli/dist and fails loudly with a build instruction when dist is missing.
- Heading match accepts levels 2 to 4 named Follow-up or Follow-ups, because the CLAUDE.md template and about 120 existing completed tasks use level 2 while the task text says level 3. Every matching heading is checked.
- The task-id prefix comes from `task_prefix` in backlog/config.yml (default AISDLC); generic prefix patterns would accept RFC-0049 or SHA-256.
- `(none)` must stand alone, per the task text. Run over the 647 existing completed tasks the rule passes 503 and fails 144, all legacy prose; none of the failures is a `(none)` or cited-id section.
- Three review rounds. Round 1 found that the Final Summary end marker was read as an item (real files failed). Round 2 found a ReDoS in the comment-line regex, reachable from task_complete and the hook. Both fixed; the third round is one past the two-round cap, taken because a major security finding should not ship.
- Reviewer leaves for this PR carry harnessTranscriptHash=null: the session produced no SubagentStart markers, so the diff-binding nonce is not bound to the reviewer transcripts.

## Verification
- `pnpm build` — passed
- `pnpm test` — affected suites passed (rule 35/35, test:followup-gate 14/14, task_complete 7/7); the full root suite was not run
- `pnpm lint` — passed
- `pnpm format:check` — passed on touched files
- `pnpm dark-code:check` — passed
- 3 parallel reviews approved (Claude-native reviewers for all three roles)

## Follow-up
- AISDLC-661: fence, long-heading, embedded-marker and unclosed-fence bypasses of the gate.
- declined: adding the new gate to the CLAUDE.md Hooks section, because the task limited CLAUDE.md edits to the one template line.
- declined: accepting `(none) — reason`, because the task text requires the section's only content to be `(none)`.
<!-- SECTION:FINAL_SUMMARY:END -->
