---
id: AISDLC-442
title: 'docs: clarify remote-sandbox read-only constraint + improve error path when CCR tries /ai-sdlc execute (closes GH issue 701)'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - documentation
  - remote-sandbox
  - developer-experience
  - rfc-0012
dependencies: []
references:
  - CLAUDE.md
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
priority: medium
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (GH issue GH issue 701)

A Claude Code agent running in the managed remote execution environment (CCR remote sandbox) cannot run `/ai-sdlc execute` against a freshly-filed backlog task. The sandbox lacks the prerequisites the slash command body assumes:

- No signing key (`~/.ai-sdlc/signing-key.pem` is operator-machine-local)
- No plugin install (no `mcp__plugin_ai-sdlc_ai-sdlc__*` MCP tools)
- No worktree creation rights (sandbox filesystem layout differs)
- No operator filesystem (`.ai-sdlc/trusted-reviewers.yaml` pubkeys not accessible)

CLAUDE.md already documents this: *"Remote agents (`/schedule`) — read-only by design"*. The issue's value is surfacing that (a) the failure path when CCR tries `/ai-sdlc execute` is unhelpful (cryptic errors instead of "remote sandbox is read-only — file a backlog task instead"), and (b) the existing documentation could be more prominent / discoverable.

## Scope

- **Defensive error path**: when `/ai-sdlc execute` detects it's running in a CCR remote sandbox (env-var heuristic — `CLAUDE_CODE_ENV=ccr` or similar), refuse early with an operator-actionable message pointing at the read-only docs + suggesting the backlog-task-file-via-MCP path that DOES work in CCR (filing a backlog task or GitHub issue for local pickup).
- **Surface the constraint earlier**: add a section to `CLAUDE.md` explaining the remote-sandbox / local-session split. Also add a top-level note to `docs/operations/remote-agents-readonly.md` (create if missing).
- **Document the workaround flow**: CCR sandbox can do `mcp__backlog__task_create` + `mcp__github__create_issue` perfectly fine — that's the supported path. The local operator session picks the task up next.
- **NOT in scope** for this task: building the actual remote-sandbox bridge that would enable `/ai-sdlc execute` from CCR. That's an RFC-class architectural decision (would need to address signing-key transport, attestation trust model, worktree filesystem differences). Research from earlier session at `/tmp/issue-701-research.md` (operator) covers 4 architectural paths if/when the operator wants to take it on.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `/ai-sdlc execute` slash command body detects CCR remote-sandbox environment (env-var or filesystem heuristic) and refuses with an operator-actionable error pointing at the read-only path
- [ ] #2 Refusal message names the supported alternative: file a backlog task (`mcp__backlog__task_create`) or GitHub issue for local pickup
- [ ] #3 New section in `CLAUDE.md` (or expand existing "Remote agents" section) explaining the local-vs-remote split with concrete examples of what works where
- [ ] #4 `docs/operations/remote-agents-readonly.md` created (or expanded if exists) covering: what CCR can do, what it can't, why, and the supported handoff workflow
- [ ] #5 PR body closes GH issue 701
- [ ] #6 Hermetic test for the env detection + refusal path
- [ ] #7 80%+ patch coverage on new code
<!-- AC:END -->
