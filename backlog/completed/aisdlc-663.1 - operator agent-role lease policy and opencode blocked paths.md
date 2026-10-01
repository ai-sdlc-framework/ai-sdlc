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
`.ai-sdlc/agent-role.yaml` now carries the lease-on-own-branch force-push policy (`spec.governance.allowForcePush: leaseOnOwnBranch`) and the seven-entry `spec.governance.operational` list defined by the governance task, and `opencode.json`, `opencode.jsonc` and `.opencode/**` (root and nested) are added to `constraints.blockedPaths`. Authored by the operator as a separate PR because governance is never relaxed from the PR tree it governs.

## Changes
- `.ai-sdlc/agent-role.yaml`: `spec.governance` block and six OpenCode `blockedPaths` entries (the three root forms plus the `**/` nested forms); the existing `blockedActions` and every other constraint are unchanged.
- This task file.

## Design decisions
- Pushes to `main` and `master` stay denied: the `blockedActions` entries remain in force for every form other than the single allow-listed lease shape on an agent's own task branch, and the resolver's protected-branch defaults apply.
- The policy takes effect only after this PR is merged by a human; executors can lease-push their own task branches only from then on.

## Verification
- The YAML validated with the governance resolver from the governance task: force-push mode `leaseOnOwnBranch`, operational list intact, `protectedBranches` empty (defaults apply).
- Three parallel reviews and a v6 attestation cover this PR (AC 4).

## Follow-up
- declined: block `.claude/settings*`, `.husky/**` and `ai-sdlc-plugin/hooks/**` in `blockedPaths`. Executors legitimately edit hooks and `.husky` (for example plugin-hook tasks), so this needs a separate operator decision.
- declined: read the trusted policy from a git object on `main` instead of the main checkout's working-tree file. A Bash write to the parent could widen the grant until the parent next syncs; accepted residual risk, bounded because the protected-branch defaults cannot be removed.
- declined: gate the `operational` ids (`answer-operational-decisions`, `clear-executor-context`) in code. They are a closed, validated set but render as banner text only; limiting the dispatch role to operational-scope decisions in the decision CLI is deferred.
- declined: load `ai-sdlc-plugin/hooks/enforce-blocked-actions` from the main checkout or plugin root. A worktree-rooted session runs its own checkout's copy of the hook; loading it from the trusted location is a hardening for a separate change to the hook.
- declined: bind the own-branch check to the session's project worktree instead of the tool's working directory (a session that changes into a sibling worktree could lease-push that branch; `main` and `master` stay unreachable).
- declined: cover Bash writes in `blockedPaths` (it applies to Write/Edit only, like the existing `.ai-sdlc/**` floor); the enforcement for OpenCode config belongs to the OpenCode governance plugin and the sandbox.
- declined: deny a non-force `git push origin HEAD:<protected>` in the hook (GitHub branch protection on `main` is the backstop); a separate hook rule is recommended.
