---
id: AISDLC-168
title: 'Add rebase-before-push hard rule to developer subagent prompt'
status: Done
assignee: []
created_date: '2026-05-02'
labels:
  - spec
  - plugin
  - agent-prompt
  - devloop
dependencies: []
references:
  - ai-sdlc-plugin/agents/developer.md
  - backlog/completed/aisdlc-164 - Strengthen-developer-subagent-prompt-push-and-PR-are-required.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
For weeks the operator has observed a recurring failure mode in the developer subagent: dev pushes a branch, by the time CI runs `main` has moved, the PR lands BEHIND `main`, GitHub auto-merge cannot proceed, and the operator has to manually rebase OR a follow-up commit retriggers CI on the rebased SHA. **Cost per occurrence: 2x CI cycles + manual operator action + delay before merge.** Multiplied across the autonomous-loop pattern, this is a real waste. The user-memory note `feedback_pull_main_proactively.md` documents the contract: `git fetch origin main && git rebase origin/main` is not reactive cleanup after a conflict surfaces — it is a proactive precondition of every push.

AISDLC-164 strengthened the developer subagent's push + PR contract but did NOT add the rebase-before-push step. This task closes that gap by adding a hard rule, examples, mechanical-conflict scope guidance, and the `--force-with-lease` carve-out to Hard Rule #2 (since rebase changes the SHA).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc-plugin/agents/developer.md` Definition-of-Done section gains a hard rule: "BEFORE pushing, you MUST `git fetch origin main && git rebase origin/main`. If conflicts arise: resolve mechanical conflicts (lock files, CHANGELOG order, package.json bin lists, formatting drift) yourself; on semantic conflicts STOP and report rather than guessing."
- [x] #2 The push step changes from `git push --set-upstream` to `git push --force-with-lease --set-upstream` since rebase changes the SHA, with an explicit Hard Rule #2 carve-out permitting `--force-with-lease` (and ONLY that variant) after rebase.
- [x] #3 CORRECT-behavior example added: rebase clean -> push --force-with-lease -> no behind state. A second CORRECT example covers the mechanical-conflict path (CHANGELOG concatenation).
- [x] #4 WRONG-behavior example added: skip rebase -> push -> PR opens BEHIND main -> operator manually rebases. A second WRONG example covers auto-resolving a semantic conflict instead of escalating.
- [x] #5 Rationale paragraph cross-references memory note `feedback_pull_main_proactively.md` and explains the 2x-CI-cycles cost and the autonomous-loop multiplier.
<!-- AC:END -->

## Implementation Notes
<!-- SECTION:NOTES:BEGIN -->
Single-file edit to `ai-sdlc-plugin/agents/developer.md`:

- **Definition of Done** numbered list expanded from 3 to 4 items: rebase inserted as item 2, push (now `--force-with-lease`) as item 3, PR creation as item 4.
- **Hard rule** at the top of the section now reads "you MUST rebase, push, and open the PR" — rebase is named first.
- **New "Why rebase-before-push is mandatory"** subsection explains the 2x-CI-cycles cost, the autonomous-loop multiplier, and cross-references `feedback_pull_main_proactively.md` by name.
- **New "Mechanical-conflict scope" subsection** lists six recurring patterns the dev MUST auto-resolve (`pnpm-lock.yaml`, `CHANGELOG.md` Unreleased, `package.json` `bin:` list, prettier drift, `.active-task` sentinel, non-overlapping new-file additions) and four patterns the dev MUST escalate (source-file function-body conflicts, schema conflicts, test assertion conflicts, anything requiring intent understanding).
- **Two new CORRECT examples**: clean rebase + push, and rebase-with-mechanical-conflict + push.
- **Two new WRONG examples**: skip-rebase-and-push-behind (the headline failure mode this task targets), and auto-resolve-semantic-conflict (the wrong way to "handle" the rebase requirement). The previously existing WRONG example (commit-but-no-push from AISDLC-160/161/162) is preserved.
- **Hard Rule #2** updated from "Never force-push" to "Never force-push without a lease" with an explicit carve-out: `--force-with-lease` is permitted and required after rebase; `--force` (no lease) remains forbidden.
- **Workflow blockquote** updated to enumerate the rebase command, the `--force-with-lease` push command, and to require three mandatory progress lines: `rebase:`, `push:`, and `pr:`.

No other prompt content changed — file budget = 1.

This PR is **dogfood**: the developer agent executing this task must itself rebase onto `origin/main` before pushing. If the resulting PR lands BEHIND `main`, the agent has demonstrated the exact failure mode the PR is designed to prevent.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
Added a rebase-before-push hard rule to the developer subagent prompt (`ai-sdlc-plugin/agents/developer.md`), closing the gap left by AISDLC-164. The Definition-of-Done section now mandates `git fetch origin main && git rebase origin/main` before push, with `--force-with-lease` carved out of Hard Rule #2 since rebase changes the SHA. Mechanical-conflict scope guidance lets the dev auto-resolve six recurring patterns (lock files, CHANGELOG Unreleased order, `package.json` bin lists, prettier drift, `.active-task` sentinel, non-overlapping new files) while escalating semantic conflicts in source/schema/test bodies.

## Changes
- `ai-sdlc-plugin/agents/developer.md` (modified): Definition of Done expanded to 4 steps with rebase as step 2 and `--force-with-lease` push as step 3; new "Why rebase-before-push is mandatory" rationale section cross-referencing `feedback_pull_main_proactively.md`; new "Mechanical-conflict scope" section listing auto-resolve vs escalate patterns; two new CORRECT examples (clean rebase, mechanical-conflict resolve) and two new WRONG examples (skip-rebase-push-behind, auto-resolve-semantic-conflict); Hard Rule #2 updated to permit `--force-with-lease` exclusively; workflow blockquote requires three mandatory progress lines (`rebase:`, `push:`, `pr:`).
- `backlog/completed/aisdlc-168 - ...md` (new): this task file, created in `completed/` per Done-semantics for `/ai-sdlc execute`-path tasks.

## Design decisions
- **Rebase named first in the hard rule** ("you MUST rebase, push, and open the PR"): puts the new requirement at the front of the model's attention budget where AISDLC-164's push+PR rule already lives, rather than adding a footnote that might be skipped.
- **Mechanical-conflict scope enumerated with concrete patterns**: a generic "resolve mechanical conflicts" instruction would invite the model to call any conflict mechanical when convenient. Listing the six patterns explicitly and naming four escalation triggers gives unambiguous guidance.
- **`--force-with-lease` carved out of Hard Rule #2 rather than added as an exception elsewhere**: keeps the hard-rule numbering authoritative; readers seeing "Never force-push" in #2 immediately read the lease carve-out in the same paragraph rather than discovering it three sections later.
- **Two CORRECT and two WRONG examples instead of one each**: the mechanical-conflict CORRECT example shows the dev what successful auto-resolve looks like; the auto-resolve-semantic-conflict WRONG example forecloses the obvious failure mode where a dev applies the auto-resolve permission too broadly.

## Verification
- `pnpm lint` -- clean
- `pnpm format:check` -- clean

## Follow-up
Observe whether subsequent dev runs land PRs at-or-ahead of `main`. If "PR opens BEHIND main" still surfaces, consider an orchestrator-side preflight that runs `git fetch origin main && git merge-base --is-ancestor origin/main HEAD` before accepting the dev's return JSON, and re-prompts on failure. (Today this would catch the regression after-the-fact; making it the orchestrator's responsibility is a defense-in-depth layer the prompt change alone cannot provide.)
