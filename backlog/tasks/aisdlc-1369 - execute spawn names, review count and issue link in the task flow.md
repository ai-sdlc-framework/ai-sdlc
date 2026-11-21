---
id: AISDLC-1369
title: 'Execute spawns agents by their registered names, the task file states the real review count, and the PR links the issue'
status: To Do
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - execute
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/next-step.test.ts
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/ship.test.ts
  - pipeline-cli/src/steps/10-finalize.ts
  - pipeline-cli/src/steps/10-finalize.test.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/steps/11-push-and-pr.test.ts
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/execute.test.mjs
  - docs/operations/backlog-and-execution-reference.md
priority: medium
---

## Description

**Gap.** Three small defects in the `/ai-sdlc:execute` task flow from one adopter run: the agent is spawned under a name the plugin does not register, the task file claims three reviews when two ran, and a task that references a GitHub issue does not close it. Source: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2754 (items 1, 2 and 3).

**Facts read in code** (main at 687e0d596).

- Item 1. `pipeline-cli/src/next-step/next-step.ts:363` sets `agent: 'developer'` on the `spawn-developer` instruction. `ai-sdlc-plugin/commands/execute.md:97` tells the session to spawn `subagent_type: developer`, and `execute.md:103` spawns reviewers with `subagent_type` = the instruction's `agent` (`next-step.ts:385` passes `r.agent`, for example `code-reviewer`). The `allowed-tools` line at `execute.md:10` lists `Agent(developer, code-reviewer, test-reviewer, security-reviewer, review-planner, review-synthesizer)`. The agent files in `ai-sdlc-plugin/agents/` belong to the plugin named `ai-sdlc`, and `ai-sdlc-plugin/README.md:31` already writes `Agent(subagent_type='ai-sdlc:code-reviewer-codex')`. No file on main uses the `ai-sdlc:` prefix for the developer.
- Item 2. `pipeline-cli/src/steps/10-finalize.ts:112` writes the literal line `- 3 parallel reviews approved` followed by `harnessNote`. `harnessNote` is the planned-harness note carried on the verdict (`ship.ts:442`, `types.ts:552`), not a description of who ran. `buildFinalSummary` already receives `verdict.verdicts` (one entry per reviewer that reported), and `review-finalize.ts:270-280` records the harness that actually ran when a reviewer fell back.
- Item 3. `pipeline-cli/src/steps/11-push-and-pr.ts:162-212` writes `Closes #N` only when `sourceKind === 'gh-issue'` with an issue number; otherwise the footer is `References <taskId>`. The `next-step` caller builds the body at `ship.ts:610-628` without those options and then appends its own `References` footer. A backlog task whose `references` lists an issue of the same repository therefore never closes it. Whether that is by design is not stated in `docs/operations/backlog-and-execution-reference.md`.

**Observed** (from the issue, not reproduced here). The first developer spawn failed with `Agent type 'developer' not found` and the session retried as `ai-sdlc:developer`. The Verification section of a finished task read `3 parallel reviews approved (; reviewer harness=codex (source: default))` after two Claude Code reviewers ran. The merged PR did not close the referenced issue; it was closed by hand.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the instruction should carry the name Claude Code accepts, and the task file should state facts, not a constant. Whether a task PR closes an issue is a policy choice and goes to Open questions. 2. Deleted: the literal `3` and the planned-harness text in the summary line; the unprefixed names in `execute.md`. 3. Simplified or optimised: one constant for the plugin agent prefix in `pipeline-cli`, used by the `spawn-developer` instruction and the reviewer instructions; `execute.md` then needs no rule of its own beyond "spawn `agent` as given". 4. Accelerated: the first spawn succeeds, so no retry round trip. 5. Automated: tests assert the names, the summary line and the PR body.

- Make the `spawn-developer` and reviewer instructions carry `ai-sdlc:developer`, `ai-sdlc:code-reviewer` and the other registered names; update `execute.md:10`, `:97` and `:103` to match. A test reads `ai-sdlc-plugin/agents/*.md` names and the plugin name from `plugin.json` and checks every agent the instructions can name resolves to one of them.
- Change `10-finalize.ts:112` to print the number of reviewers in `verdict.verdicts` and the harness each one ran on, taken from the run record, not from the planned note. Drop the empty `(; ...)` fragment when there is no note.
- Item 3 follows the answer to the open question below.

Out of scope: the GitHub-issue path (`gh:N`), which already writes `Closes #N`; plugin install order; the docs spelling of the command.

## Open questions

**Should a backlog-task PR close a GitHub issue named in the task `references`?** The code treats it as by design for backlog tasks (the `References <taskId>` footer), and the issue says that is unclear.

- Option A: close it. Parse `references` for an issue URL of the same repository and write `Closes #N`. Matches adopter expectation; risks closing an issue the task only mentions.
- Option B: do not close it; state this in `docs/operations/backlog-and-execution-reference.md` and the adopter docs, and point to a task field for an explicit opt in.
- Option C: close only when the task frontmatter has an explicit `closes:` entry.

Interim value the developer uses: option B (docs line only, no behaviour change). Recommendation: option C, because it keeps the safe default and gives adopters the one-line fix; it is a separate small task once chosen.

## Acceptance Criteria

- [ ] #1 A test shows the `spawn-developer` instruction and every reviewer instruction name an agent that exists as `<plugin name>:<file name>` in `ai-sdlc-plugin/agents/`.
- [ ] #2 `ai-sdlc-plugin/commands/execute.md` `allowed-tools` and its spawn text use the same registered names, and `execute.test.mjs` checks this.
- [ ] #3 A test with two reviewer verdicts (one claude-code, one that fell back from codex) shows the Verification line states `2` reviews and each actual harness, and never the text `3 parallel`.
- [ ] #4 A test shows the Verification line has no `(;` fragment when the verdict has no harness note.
- [ ] #5 The docs state what happens to a GitHub issue named in a task `references` on merge, matching the answer to the open question (interim: it is not closed), and a test or doc check covers the sentence.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
