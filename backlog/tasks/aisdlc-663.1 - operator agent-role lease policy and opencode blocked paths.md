---
id: AISDLC-663.1
title: 'Operator step: agent-role lease-on-own-branch policy and OpenCode blocked paths'
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - governance
  - operator
priority: high
dispatchable: false
dispatchableReason: 'Edits .ai-sdlc/agent-role.yaml, a fixed floor for agents; operator-authored PR only'
references:
  - .ai-sdlc/agent-role.yaml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator step carried from AISDLC-663 (AC 9). Agents never edit `.ai-sdlc/**`, and governance is never relaxed from the PR tree it governs, so the repo's own `.ai-sdlc/agent-role.yaml` change ships as a separate operator-authored PR after the governance task merges.

This PR makes two changes to `.ai-sdlc/agent-role.yaml`:

1. Set the lease-on-own-branch force-push policy and the operational list defined by the governance task, so executors can lease-push their own task branches without a per-session operator confirmation. Pushes to `main` and `master` stay denied.
2. Add `opencode.json`, `opencode.jsonc` and `.opencode/**` to `blockedPaths`, so an agent in a worktree cannot rewrite the OpenCode governance plugin or its permissions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.ai-sdlc/agent-role.yaml` carries the lease-on-own-branch policy and operational list exactly as given in the governance task's PR body, and validates against the schema that task ships
- [ ] #2 `blockedPaths` includes `opencode.json`, `opencode.jsonc` and `.opencode/**`
- [ ] #3 Pushing to `main` or `master` with any force form remains denied
- [ ] #4 A v6 attestation covers this PR (config change, not docs-only)
<!-- AC:END -->
