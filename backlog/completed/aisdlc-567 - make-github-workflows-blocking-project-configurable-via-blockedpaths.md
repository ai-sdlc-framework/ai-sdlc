---
id: aisdlc-567
title: Make `.github/workflows/**` blocking project-configurable via agent-role blockedPaths + isolate agents from sibling repos
status: To Do
priority: high
labels:
  - governance
  - worktree-isolation
  - adoption
---

## Description

Two related problems surfaced when a downstream consumer repo (which the operator
permits to edit its own CI workflows) hit the PreToolUse governance, and the
agent working for it made **direct, uncommitted edits to the ai-sdlc framework
repo's read-only parent working tree** (from a 2-commit-stale base, reverting
merged AISDLC-554/557/559 work as collateral). See GitHub issue #977 for the full
incident write-up; the debris was discarded and its intent captured here.

### Part A — configurable workflow blocking

Today the PreToolUse hook hard-blocks `Write`/`Edit` on `.github/workflows/**`
for every agent in every project. Consumer repos that legitimately want agents to
maintain their own CI have no supported opt-in. Make it project-configurable:

- `.github/workflows/**` is **NOT** blocked by default.
- It is refused **only** when the project's `.ai-sdlc/agent-role.yaml` lists it
  (or a matching glob) under `blockedPaths`.
- `.ai-sdlc/**` remains never-editable regardless.
- Net rule: refuse `Write`/`Edit` on `.ai-sdlc/**`, any path in the project's
  `agent-role.yaml` `blockedPaths`, and any path outside the worktree not in
  `permittedExternalPaths`.

Surfaces: the PreToolUse hook enforcement + the `agent-role.yaml` schema/loader,
and the governance text in the agent/command docs (`developer`, `execute`,
`orchestrator-tick`, `dispatch-worker`, reviewer/resolver agents) plus their tests.
(Note: internal CLAUDE.md already says the workflow-edit rule is external-only —
this task makes the *enforcement* match that intent and makes it configurable.)

### Part B — isolate agents from sibling/parent repos (the incident's root cause)

An agent scoped to repo X was able to write into an unrelated framework checkout Y
on the same machine because Y was a filesystem sibling. Harden isolation:

- An agent should not be able to `Write`/`Edit` any path **outside its active
  worktree** that is not in `permittedExternalPaths` — regardless of whether the
  target is itself a git repo. (Extends the existing outside-worktree refusal to
  cover sibling repos, not just loose files.)
- Warn/refuse when the agent's working tree HEAD is behind `origin/main` before it
  begins mutating, so stale-base edits can't silently revert merged work.

## Acceptance Criteria

- [ ] `.github/workflows/**` is editable by default and refused only when listed
      in the project's `agent-role.yaml` `blockedPaths`; `.ai-sdlc/**` still never
      editable. Enforced in the PreToolUse hook, with hermetic tests for both the
      permitted and blocked configurations.
- [ ] `agent-role.yaml` schema/loader documents and validates `blockedPaths`.
- [ ] Agent/command governance docs updated to state the configurable rule; their
      tests assert `blockedPaths` scoping (not a hardcoded `.github/workflows` ban).
- [ ] PreToolUse refuses writes to any sibling repo / path outside the active
      worktree not in `permittedExternalPaths`, with a hermetic test simulating a
      sibling-repo path.
- [ ] Stale-base guard: an agent whose worktree HEAD is behind `origin/main`
      surfaces a warning (or refusal) before mutating; covered by a test.
