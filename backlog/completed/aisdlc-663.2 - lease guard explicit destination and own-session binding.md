---
id: AISDLC-663.2
title: >-
  Lease-push guard: accept only the explicit refs/heads destination and bind the lease to the session's own worktree
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - governance
  - hooks
  - plugin
  - security
dependencies:
  - AISDLC-663
references:
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lease-push-docs.test.mjs
  - ai-sdlc-plugin/commands/rebase.md
  - docs/api-reference/governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A security review of the operator YAML change found a major hole in the merged lease-push
guard. With `allowForcePush: leaseOnOwnBranch` the guard accepts the no-colon form
`git push --force-with-lease [-u] origin <own>`, assuming git sends it to
`refs/heads/<own>`. Git does not: a no-colon refspec is mapped through `remote.origin.push`,
and under `push.default=upstream|tracking` through `branch.<own>.merge`. Task branches are
created from `origin/main` (`git worktree add <path> -b <branch> origin/main`), so every
task branch tracks main (`branch.<own>.merge=refs/heads/main`). Two exploits follow:

1. Accidental: an operator with `push.default=upstream` runs the hook-sanctioned command and
   the task branch is force-pushed onto main.
2. Deliberate: one `git config remote.origin.push refs/heads/<own>:refs/heads/main`, then the
   sanctioned lease push.

The main branch's classic protection currently allows force pushes, so this guard is the only
barrier. The fix makes the explicit destination mandatory and tightens which session may use
the lease. Parent task AISDLC-663 and its design source, RFC-0051 section 10, define the
policy.

## Conventions
- Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md` section 10. Its
  Open Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict and ESM for packages; `node --test` for plugin hooks; 80% line coverage on
  new code. Tests use real git in temporary directories with isolated HOME and git config,
  never the real home directory, tmux or the network.
- Do not edit anything under `.ai-sdlc/`.

## Scope
1. **Explicit destination only.** The guard accepts only
   `git push --force-with-lease[=<ref>:<sha>] [-u] origin HEAD:refs/heads/<own>`. The no-colon
   form is refused in every case. Update every command, agent, skill and doc body and the
   docs-parsing test that still uses the no-colon form.
2. **Own-session binding.** When the project directory (`CLAUDE_PROJECT_DIR`) is a task
   worktree, the real path of the worktree top must equal the real path of the project
   directory, so a session that changes into a sibling worktree gets no lease. When the
   project directory is the main checkout, the worktree top must be a genuine
   `<mainRoot>/.worktrees/<id>` whose sentinel, directory name and branch agree. Document the
   rule.
3. **Regression tests with real git** for both exploits, on a task-bound branch that tracks
   main: set `push.default=upstream`, and separately set `remote.origin.push` to
   `refs/heads/<own>:refs/heads/main`. Each test first shows the unguarded no-colon push would
   update main on a bare origin, then asserts the guard denies it. Also cover the sibling
   worktree case and that the explicit form still works.
4. **Docs and PR body:** describe the single accepted spelling and the own-session rule in
   `docs/api-reference/governance.md`.

## Acceptance Criteria
- [x] The guard denies `git push --force-with-lease [-u] origin <own>` in every form, and allows `git push --force-with-lease[=<ref>:<sha>] [-u] origin HEAD:refs/heads/<own>` from a task-bound worktree.
- [x] A real-git test with `push.default=upstream` on a task branch tracking main shows the unguarded no-colon push updates main on a bare origin, and the guard denies that command.
- [x] A real-git test with `remote.origin.push` set to `refs/heads/<own>:refs/heads/main` shows the same, and the guard denies it.
- [x] A session whose project directory is one task worktree is denied a lease push from a sibling worktree, and allowed from its own.
- [x] No command, agent, skill or doc body prescribes the no-colon form, and the docs-parsing test fails if one reintroduces it.
- [x] No file under `.ai-sdlc/` is changed.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
The lease-push guard now accepts only `git push --force-with-lease[=<branch>:<sha>] [-u] origin HEAD:refs/heads/<own>` (sources `HEAD`, the own branch or `refs/heads/<own>`; destination exactly `refs/heads/<own>`). The no-colon form is refused in every spelling, with a deny message naming the accepted spelling. A session whose project directory is a task worktree may use the lease only from that very worktree.

## Changes
- `ai-sdlc-plugin/hooks/lib/lease-push-guard.js` (modified): the no-colon branch now denies; the alias probe stays, fail-closed, because it still guards sources that name the own branch.
- `ai-sdlc-plugin/hooks/lib/trusted-policy.js` (modified): own-session binding in `resolveLeaseWorktree`.
- `ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs`, `lease-push-docs.test.mjs`, `lib/lease-push-guard.test.mjs`, `lib/trusted-policy.test.mjs` (modified): real-git exploit reproductions, sibling-worktree cases, the docs-parsing test now also requires an explicit `HEAD:refs/heads/<branch>` destination in every prescribed push, and dotted sub-id coverage (`aisdlc-663.2`).
- `docs/api-reference/governance.md`, `docs/operations/operator-runbook.md`, `CLAUDE.md` (modified): single accepted spelling, why the no-colon form is unsafe, own-session rule, other push-affecting config.

## Design decisions
- **Explicit destination only**: git maps a no-colon refspec through `remote.<name>.push` and, under `push.default=upstream|tracking`, `branch.<own>.merge`, which for a task branch created from origin/main is refs/heads/main. Both were reproduced against a bare origin: the unguarded command overwrote main for `push.default=upstream`, `push.default=tracking` and `remote.origin.push=<own>:refs/heads/main`.
- **Own-session binding**: project dir equals the worktree top, or the project dir is the main checkout and the worktree is a genuine bound `.worktrees/<id>`.
- **Out of scope by design**: `remote.<name>.pushurl` / `pushInsteadOf` redirect the branch name to another repository, which is not this guard's trust boundary.

## Verification
- `pnpm build` clean; governance gate 502 passing; reference suite 1591 passing; lint, format:check, dark-code:check, validate-schemas clean.
- `pnpm -r test` fails only on the known environmental pipeline-cli items (verify-runtime, bin-invocation `pnpm exec` probes, TUI render timeouts), so AC 7 is left unchecked.

## Follow-up
- declined: hook-level protection of `.active-task` writes, the directory-name and branch-prefix agreement is the accepted check
- declined: parsing `bash -c` payloads, pre-existing matcher limit documented in governance.md

