---
id: AISDLC-709
title: >-
  Project-scoped session names so hierarchies from different projects do not cross-talk
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - rfc-0051
  - hierarchy
  - bug
dependencies:
  - AISDLC-667
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Session hierarchies from two projects on one machine collide. Both the ai-sdlc and a
second project ran `cli-hierarchy up`, so both had sessions named `planner` and
`executor-alpha` .. `executor-delta`. Peer messages resolve bare names across the whole
machine. On 2026-10-03: the other project's planner sent a task to "executor-epsilon" and
it reached the ai-sdlc executor (refused only because of an ad-hoc instruction); the
other project's task ran on the ai-sdlc `executor-beta`, which opened a pull request
against the ai-sdlc repository with another project's work; the ai-sdlc dispatch session
messaged the other project's planner by bare name. Result: live cross-project writes,
and a stray PR on the wrong repository.

References: RFC-0051, DEC-0038.

Sequenced after the task listed under dependencies: it changes the same files
(`cli-hierarchy` and the executor skill), so start from main after it lands. If the
one-tmux-session-per-agent work is still open, rebase on whichever lands first.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] `cli-hierarchy up` qualifies every session name with the project: `<project>/<role>` (for example `ai-sdlc/executor-beta`), where project defaults to the repository basename and can be set with `--project`; the project is recorded in hierarchy.json for every roster entry. If the peer-messaging name format does not allow `/`, pick a separator it allows and document it.
- [ ] Every place that resolves a peer uses the qualified name or the recorded ref from hierarchy.json, never a bare role name: the executor skill, the operator-dispatch skill, the planner skill, and the brief `--notify` path. A lint or test fails if a skill body addresses a bare role name.
- [ ] The executor skill refuses any dispatch or instruction whose sender is not the dispatch session in its own roster, compared by pid or ref against hierarchy.json, not by the name the message claims. The refusal is one line, "not my dispatch session", and nothing else happens (no claim, no worktree, no PR).
- [ ] The planner and operator-dispatch skills likewise only address sessions found in their own roster.
- [ ] Before doing repository work, the executor checks that its working directory's repository is the project in its roster; a mismatch stops the run with a clear message. (This is what would have prevented the stray PR.)
- [ ] `cli-hierarchy up` refuses, or warns loudly and requires `--project`, when sessions with the same unqualified role names are already running on the machine for a different project.
- [ ] Tests: two rosters on one machine with identical role names; a message from the foreign dispatch session is refused; a message from the own dispatch session is accepted; generated names include the project; the repository-mismatch check stops the run.
- [ ] Migration: an existing hierarchy.json without a project field is read as the repository basename, and `cli-hierarchy up` rewrites it; documented.
- [ ] Docs: a short page section on running more than one hierarchy on the same machine. It states that these checks are a mistake guard in the DEC-0038 sense, not authentication.

## Out of scope
- Authentication between sessions.
- Cross-machine hierarchies.
<!-- SECTION:DESCRIPTION:END -->
