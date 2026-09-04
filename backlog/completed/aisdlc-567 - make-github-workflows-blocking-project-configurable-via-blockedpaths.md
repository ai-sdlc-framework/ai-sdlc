---
id: aisdlc-567
title: Make `.github/workflows/**` blocking project-configurable via agent-role blockedPaths + isolate agents from sibling repos
status: Done
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

- [x] `.github/workflows/**` is editable by default and refused only when listed
      in the project's `agent-role.yaml` `blockedPaths`; `.ai-sdlc/**` still never
      editable. Enforced in the PreToolUse hook, with hermetic tests for both the
      permitted and blocked configurations.
- [x] `agent-role.yaml` schema/loader documents and validates `blockedPaths`.
- [x] Agent/command governance docs updated to state the configurable rule; their
      tests assert `blockedPaths` scoping (not a hardcoded `.github/workflows` ban).
- [x] PreToolUse refuses writes to any sibling repo / path outside the active
      worktree not in `permittedExternalPaths`, with a hermetic test simulating a
      sibling-repo path.
- [x] Stale-base guard: an agent whose worktree HEAD is behind `origin/main`
      surfaces a warning (or refusal) before mutating; covered by a test.

## Final Summary

**Part A** — `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` already drove
`blockedPaths` from the project's own `.ai-sdlc/agent-role.yaml` (not a
hardcoded JS-level ban), so `.github/workflows/**` was already
project-configurable in the shipped hook. What was missing: (1) a HARDCODED
`.ai-sdlc/**` floor independent of config — previously, a project with no
`agent-role.yaml` (or one that dropped `.ai-sdlc/**` from `blockedPaths`) had
NO protection at all, since the hook exited early on a missing/unreadable
config file; (2) governance docs across `ai-sdlc-plugin/agents/*.md`,
`ai-sdlc-plugin/commands/*.md`, `docs/operations/ci-conflict-resolver.md`,
`pipeline-cli/README.md`, and the governance skill still described
`.github/workflows/**` as an unconditional ban. Both are fixed; `.ai-sdlc/**`
is now refused unconditionally in the hook, and all governance text now
states the `blockedPaths`-scoped rule.

**Part B** — root-caused and closed the real isolation gap: the hook's
"inside the project" check used the whole project root as the trust boundary,
so a dev subagent whose cwd was `.worktrees/<task-id>/` could write into the
PARENT repo's own working tree (or a sibling worktree) unchecked, because
both live "inside the project root" — this reproduces the incident (GitHub
issue #977) where an agent wrote into a sibling framework checkout. The hook
now resolves the agent's "home" as its ACTIVE WORKTREE (via the existing
per-worktree `.active-task` sentinel directory structure) when one is
resolvable, falling back to the project root for plain (non-Pattern-C)
projects. Paths outside that home — whether a loose file or a sibling git
repo — are denied unless covered by `permittedExternalPaths`, with no
directory-type special case. A non-blocking stale-base guard was added:
`warnIfStaleBase()` warns to stderr when the resolved worktree's HEAD is
behind the locally-cached `origin/main` ref (no network fetch from the hook).

## Changes

- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` — hardcoded `.ai-sdlc/**`
  floor; worktree-scoped `enforceWriteEdit()` via new
  `resolveActiveWorktreeDir()`; non-blocking `warnIfStaleBase()`.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs` — 3 new describe
  blocks covering Part A (configurable workflow blocking, hardcoded
  `.ai-sdlc/**` floor with/without config), Part B (worktree isolation vs.
  parent repo / sibling git repo), and the stale-base guard; 1 pre-existing
  assertion updated to match the new (accurate) deny-reason wording.
- `spec/schemas/agent-role.schema.json` — expanded `blockedPaths` description
  to document the always-on `.ai-sdlc/**` floor and the opt-in
  `.github/workflows/**` scoping.
- `ai-sdlc-plugin/agents/{developer,rebase-resolver,ci-conflict-resolver,refinement-reviewer}.md`,
  `ai-sdlc-plugin/commands/{execute,orchestrator-tick,dispatch-worker,rebase,resolve-conflicts}.md`,
  `ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md`,
  `docs/operations/ci-conflict-resolver.md`, `pipeline-cli/README.md` —
  updated governance text from a hardcoded workflow ban to the
  `blockedPaths`-scoped rule.
- `ai-sdlc-plugin/{agents/rebase-resolver,commands/{dispatch-worker,orchestrator-tick,rebase}}.test.mjs`
  — assertions updated to check for `blockedPaths` scoping language rather
  than an absolute ban.

## Verification

- `node --test ai-sdlc-plugin/hooks/*.test.mjs` — 106/106 pass.
- `node --test ai-sdlc-plugin/agents/*.test.mjs ai-sdlc-plugin/commands/*.test.mjs` —
  passes except 4 pre-existing failures also present on `origin/main` before
  this change (unrelated CHANGELOG-fixture and `$PIPELINE_CLI_BIN` bare-path
  lint tests) — confirmed via `git stash` A/B comparison.
- `npx prettier --check` — clean on all touched files.

## Follow-up

- `.claude/hooks/enforce-blocked-actions.js` is a stale, Bash-only,
  self-dogfood-only copy of an OLDER version of this hook (no Write/Edit
  enforcement at all — `.claude/settings.json`'s `PreToolUse` only wires a
  `Bash` matcher, not `Write|Edit`). It is not part of the shipped plugin
  surface (`ai-sdlc-plugin/plugin.json` is what ships and already wires
  `Write|Edit` correctly) and was out of this task's stated surfaces, so it
  was left untouched. Worth a follow-up to either delete it or bring the
  self-repo's own `.claude/` config to parity with the plugin manifest.
