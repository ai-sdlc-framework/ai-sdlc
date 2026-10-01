---
id: AISDLC-663.1
title: 'Operator step: agent-role lease-on-own-branch policy and OpenCode blocked paths'
status: Done
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
- [x] #1 `.ai-sdlc/agent-role.yaml` carries the lease-on-own-branch policy and operational list exactly as given in the governance task's PR body, and validates against the schema that task ships
- [x] #2 `blockedPaths` includes `opencode.json`, `opencode.jsonc` and `.opencode/**`
- [x] #3 Pushing to `main` or `master` with any force form remains denied
- [x] #4 A v6 attestation covers this PR (config change, not docs-only)
<!-- AC:END -->

## Final Summary

## Summary
`.ai-sdlc/agent-role.yaml` now carries the lease-on-own-branch force-push policy (`spec.governance.allowForcePush: leaseOnOwnBranch`) and the seven-entry `spec.governance.operational` list defined by the governance task, and `opencode.json`, `opencode.jsonc` and `.opencode/**` are added to `constraints.blockedPaths`. Authored by the operator as a separate PR because governance is never relaxed from the PR tree it governs.

## Changes
- `.ai-sdlc/agent-role.yaml`: `spec.governance` block and three OpenCode `blockedPaths` entries; the existing `blockedActions` and every other constraint are unchanged.
- This task file.

## Design decisions
- Pushes to `main` and `master` stay denied: the `blockedActions` entries remain in force for every form other than the single allow-listed lease shape on an agent's own task branch, and the resolver's protected-branch defaults apply.
- The policy takes effect only after this PR is merged by a human; executors can lease-push their own task branches only from then on.

## Verification
- The YAML validated with the governance resolver from the governance task: force-push mode `leaseOnOwnBranch`, operational list intact, `protectedBranches` empty (defaults apply).
- Three parallel reviews and a v6 attestation cover this PR (AC 4).

## Follow-up
(none)
