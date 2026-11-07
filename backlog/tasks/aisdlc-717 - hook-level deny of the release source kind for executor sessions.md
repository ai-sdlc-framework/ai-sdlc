---
id: AISDLC-717
title: >-
  Hook-level deny of the release source kind for executor sessions
status: In Progress
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - release
dependencies:
  - AISDLC-684
  - AISDLC-702
references:
  - ai-sdlc-plugin/hooks/lib/role-tool-policy.js
  - ai-sdlc-plugin/hooks/lib/role-tool-policy.test.mjs
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - docs/operations/release-flow.md
priority: low
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Unparked 2026-11-07 by operator ruling (planner critical-path review).

**Re-briefed 2026-11-07.** Build this as a grammar matcher in `ai-sdlc-plugin/hooks/lib/role-tool-policy.js`, the same pattern as the executor `cli-decisions` rule there (command position, node path form, wrappers fail closed). Do not add it to `enforce-blocked-actions.js`: DEC-0267 (AISDLC-1014) removed command-text matchers from that hook.

The release merge path (backlog task 702) restricts which roles may use
`--source-kind release` with a check inside the CLI. Per DEC-0038 a check performed by a
CLI that the agent itself invokes is a mistake guard, not a boundary; the boundary belongs
in the PreToolUse hook's role tool policy (`ai-sdlc-plugin/hooks/lib/role-tool-policy.js`). Deciding when
to release belongs to the planner role (DEC-0042); an executor holding a task should not
be able to land a release PR.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] The executor default rules in `role-tool-policy.js` refuse a Bash command that INVOKES `cli-merge-if-eligible` (same invocation detection as the decision-command rule: command position, node path form, wrappers fail closed) with `--source-kind release` when the session's role is executor or the session holds an active task claim.
- [ ] The refusal names the next step: "releases are run by the planner or dispatch session; escalate to your dispatch session", and never tells the agent to ask the operator.
- [ ] Planner and dispatch roles are not affected; `backlog` source kind for the executor's own task PR is not affected; a grep or cat that mentions the command passes. Tests for each.
- [ ] Admission test recorded in the PR body's "Velocity impact" section (DEC-0048): the harm prevented, that it never fires on the documented executor workflow, the exit, and that the default lets planner-run releases work with nothing configured.
- [ ] The release path docs (`docs/operations/release-flow.md`) replace "no hook-level control yet" with a description of this rule.
- [ ] A required CI check on the release-please branch re-runs the release content allowlist on every push, so a release PR that was armed for auto-merge cannot merge content that was not eligible when it was armed; the failure message names the offending path.

## Out of scope
- Changing release eligibility checks.
<!-- SECTION:DESCRIPTION:END -->
