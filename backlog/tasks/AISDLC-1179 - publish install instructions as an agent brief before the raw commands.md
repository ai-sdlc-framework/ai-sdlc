---
id: AISDLC-1179
title: 'Publish the install as an agent brief a user pastes into Claude Code, with the raw commands second'
status: To Do
assignee: []
created_date: '2026-11-04'
labels:
  - install
  - onboarding
  - docs
dependencies: []
references:
  - docs/getting-started/onboarding.md
  - docs/tutorials/08-claude-code-plugin.md
priority: medium
dispatchable: false
---

## Description

**Source.** Install friction report from the ai-sdlc-io planner session, 2026-11-04, relayed as operator-approved. `dispatchable: false` until the operator confirms this task in the ai-sdlc planner session.

**Problem.** The install is a command list, so a user runs each command in turn and stops at the first error.

**Change.** Write the install as one prose brief that a user pastes into Claude Code or another agent. It tells the agent:
- what to install;
- how to verify each step;
- what to do when a step fails. The known failure modes are a partial plugin cache install, a missing `@ai-sdlc/reference`, a keyring that was never initialised, and doctor warnings.

The agent then runs the sequence and resolves issues as they come up. The docs show this brief first and the raw commands second.

If AISDLC-1178 lands first, the brief targets the shorter path. It does not wait for 1178.

## Acceptance Criteria

- [ ] AC-1: `docs/getting-started/onboarding.md` opens with a copyable agent brief that names each install step, its verification, and the recovery for each of the four failure modes above.
- [ ] AC-2: The raw command list follows the brief, unchanged in meaning.
- [ ] AC-3: The brief is also kept as a standalone file that the ai-sdlc-io site can link to or embed, at a stable path stated in the PR body.
- [ ] AC-4: Running the brief in a fresh Claude Code session on a fresh repo reaches a passing doctor. The PR body records that run.
