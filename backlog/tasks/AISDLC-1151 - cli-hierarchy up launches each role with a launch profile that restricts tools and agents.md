---
id: AISDLC-1151
title: 'cli-hierarchy up launches each role with a launch profile: restricted tool and agent set per role, starting with the planner'
status: In Progress
assignee: []
created_date: '2026-11-01'
labels:
  - hierarchy
  - context
  - rfc-0053
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/spawn.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/types.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - .ai-sdlc/model-routing.yaml
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

A planner session's first turn carries about 60k tokens of fixed context before it does any work. A survey of the live planner transcript on 2026-11-01 measured the largest blocks: built-in tool schemas about 19k tokens (16 tools, 77k characters), the skill listing about 7.3k, the agent listing about 1.75k. The planner needs Bash, Read, Edit, Write, Agent, AskUserQuestion, Skill and SendMessage; it never uses browser automation, artifacts, workflows, notebooks or the dozen other built-in tools whose schemas it pays for on every turn. Against a 150k rotation threshold (AISDLC-1110), that fixed load leaves the planner about 60k of working room and caused the mid-turn kill that AISDLC-1150 records.

Today `buildClaudeCommand` in `pipeline-cli/src/hierarchy/up.ts` passes only `--name`, `--model` and `--permission-mode` (plus the executor MCP args of AISDLC-1067). There is no per-role launch configuration: `PlannedSession` carries `role`, `name`, `model`, `permissionMode`, `prompt` and `taskId`, and the only per-role file is `.ai-sdlc/model-routing.yaml`, which sets the model alone.

**Five-step review (requirements first).**
1. Requirement questioned: does the planner need every built-in tool? No. Its command (`ai-sdlc-plugin/commands/planner.md`) uses the shell, file reads and edits, subagents, questions and the roster send wrapper. The requirement is a smaller tool surface per role, not a bigger context window.
2. Delete: nothing to delete in the launcher; the unneeded tools are removed from the session, not from the product.
3. Simplify: one `launchProfile` per role in one place, read by `plan()` and applied by `buildClaudeCommand`, so `up`, `restart` and `spawn` all launch the same way. The roster entry records the profile so `restart` reproduces it.
4. Accelerate: a smaller fixed prefix is cached and re-read on every turn; the saving compounds over a session.
5. Automate: `buildClaudeCommand` tests assert the flags per role; `cli-hierarchy status` can show the profile name so a session launched without one is visible.

Velocity impact: positive. Roughly 20k tokens less per planner turn and a later rotation point.

## Acceptance Criteria

- [ ] AC-1: A per-role launch profile exists in `.ai-sdlc/model-routing.yaml` (or a sibling `launch:` block in the same file, whichever keeps one per-role file) with optional `allowedTools`, `disallowedTools` and `disallowedAgents` lists; `plan()` in `up.ts` resolves it into `PlannedSession.launchProfile` and `buildClaudeCommand` renders the matching `--allowedTools` / `--disallowedTools` flags (and the agent restriction the CLI supports, if any) after `--permission-mode`. Absent profile means today's command line, byte for byte.
- [ ] AC-2: The repository's default profile for `planner` disallows the tools the planner command never uses (browser automation, artifacts, workflows, notebooks and similar built-ins) and keeps Bash, Read, Edit, Write, Agent, AskUserQuestion, Skill, SendMessage, ToolSearch and the MCP backlog and ai-sdlc tools. Executors and dispatch keep today's full set unless the operator adds a profile.
- [ ] AC-3: `RosterEntry` records the profile name, and `restart.ts` and `spawn.ts` launch through the same resolution so a restarted or ephemeral session gets the same flags as `up`.
- [ ] AC-4: Tests in `hierarchy.test.ts` cover: no profile means unchanged command; planner profile renders the flags in order; restart reproduces the profile from the roster. `docs/operations/cli-hierarchy.md` gains a short "Launch profiles" section under the planner context ceiling material naming the file and the measured saving.
- [ ] AC-5: After one planner launch with the profile, `cli-hierarchy status` shows the planner's first-turn context (the `CONTEXT` column) at least 15k tokens below the value measured before the change; the number goes in the PR body.

## Notes

Origin: operator question 2026-11-01 ("why is the planner starting at 90k") and the survey the planner ran that afternoon; operator go on the three recommendations at 22:56Z. Sibling task: AISDLC-1152 wires the fixed prefix of AISDLC-782 into SessionStart and slims `planner.md` and `CLAUDE.md`. The user-settings plugin trim (Cloudflare and impeccable skills off) was applied locally by the operator on 2026-11-01 and is not part of this task.
