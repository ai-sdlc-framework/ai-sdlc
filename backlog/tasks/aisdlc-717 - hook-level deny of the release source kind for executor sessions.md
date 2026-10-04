---
id: AISDLC-717
title: >-
  Hook-level deny of the release source kind for executor sessions
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - release
dependencies:
  - AISDLC-684
  - AISDLC-702
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - docs/operations/release-flow.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The release merge path (backlog task 702) restricts which roles may use
`--source-kind release` with a check inside the CLI. Per DEC-0038 a check performed by a
CLI that the agent itself invokes is a mistake guard, not a boundary; the boundary belongs
in the PreToolUse hook (`ai-sdlc-plugin/hooks/enforce-blocked-actions.js`). Deciding when
to release belongs to the planner role (DEC-0042); an executor holding a task should not
be able to land a release PR.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] The executor default rules in the PreToolUse hook refuse a Bash command that INVOKES `cli-merge-if-eligible` (same invocation detection as the decision-command rule: command position, node path form, wrappers fail closed) with `--source-kind release` when the session's role is executor or the session holds an active task claim.
- [ ] The refusal names the next step: "releases are run by the planner or dispatch session; escalate to your dispatch session", and never tells the agent to ask the operator.
- [ ] Planner and dispatch roles are not affected; `backlog` source kind for the executor's own task PR is not affected; a grep or cat that mentions the command passes. Tests for each.
- [ ] Admission test recorded in the PR body's "Velocity impact" section (DEC-0048): the harm prevented, that it never fires on the documented executor workflow, the exit, and that the default lets planner-run releases work with nothing configured.
- [ ] The release path docs (`docs/operations/release-flow.md`) replace "no hook-level control yet" with a description of this rule.

## Out of scope
- Changing release eligibility checks.
<!-- SECTION:DESCRIPTION:END -->
