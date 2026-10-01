---
id: AISDLC-663.4
title: >-
  RFC-0051 follow-up (security): run the governance hook from a trusted root, guard git config code paths, extend default blockedPaths
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0051
  - governance
  - hooks
  - security
dependencies:
  - AISDLC-663
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/plugin.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security review of the lease guard (AISDLC-663 line of work): a worktree-rooted
session runs its own checkout's copy of `ai-sdlc-plugin/hooks/enforce-blocked-actions.sh`,
`blockedPaths` covers neither `ai-sdlc-plugin/hooks/**` nor `.claude/**`, Bash writes
never pass through `blockedPaths`, and agent-writable git config (`core.hooksPath`,
`core.sshCommand`, `credential.helper`, `url.*.insteadOf`, `ext::` transports) can run
code before a sanctioned push. Related operator-only item: branch protection on `main`
currently allows force pushes; the operator turns that off in GitHub settings.

## Scope (developer)
1. The hook executes from a trusted location: the installed plugin root, or the main
   checkout's copy when running from a worktree; a worktree's own copy is never
   executed. Document the resolution order in the hook header.
2. Built-in default `blockedPaths` in the hook include `ai-sdlc-plugin/hooks/**` and
   `.claude/**` in addition to the `.ai-sdlc/**` floor, regardless of repository
   config.
3. The Bash matcher blocks `git config` (and direct `.git/config` edits) that set
   `core.hooksPath`, `core.sshCommand`, `credential.helper`, `url.*.insteadOf` or
   `url.*.pushInsteadOf`, and any remote URL or command using the `ext::` transport.
4. Hermetic `node --test` coverage for each rule.

## Operator step (not a developer AC)
After merge, the operator may mirror the two new default paths into this repository's
`.ai-sdlc/agent-role.yaml` `blockedPaths` for visibility; the hook enforces them
regardless. The developer agent does not edit `.ai-sdlc/`.

## Acceptance Criteria
- [ ] A session rooted in a worktree executes the hook from the plugin root or main checkout, never the worktree copy (test with a deliberately modified worktree copy).
- [ ] Writes to `ai-sdlc-plugin/hooks/**` and `.claude/**` are refused with no repository config present.
- [ ] Each listed `git config` key and the `ext::` transport are blocked in the Bash matcher; ordinary `git config user.name` is allowed.
- [ ] The hook header documents the trusted-root resolution order.
- [ ] `pnpm test:governance-resolver-gate` and the full `pnpm test` pass.
<!-- SECTION:DESCRIPTION:END -->
