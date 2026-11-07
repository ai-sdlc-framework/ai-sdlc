---
id: AISDLC-731
title: >-
  Untrusted runs: pipeline push runs worktree code with operator privileges; .git hooks and config are unprotected
status: Done
assignee: []
created_date: '2026-10-05'
updated_date: '2026-11-07 00:00'
labels:
  - security
  - governance
  - hooks
dependencies:
  - AISDLC-720
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - scripts/pre-push-patch-coverage.mjs
  - .husky/pre-push
  - docs/api-reference/governance.md
priority: low
dispatchable: true
dispatchableReason: 'Scoped and unparked 2026-11-07 by operator ruling (decision rubric, planner session); absorbs AISDLC-663.4 section 1.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Threat model (scope of this task)

Untrusted runs: work sourced from GitHub issues or untrusted contributors, as AISDLC-720
defines them (`AI_SDLC_UNTRUSTED_RUN` or the git-dir untrusted marker), that reach the
pipeline push. The attacker controls the worktree content, `.husky/*`, scripts, and can
write `.git/hooks` and `.git/config` (`core.hooksPath`, `core.sshCommand`,
`credential.helper`, `url.*.insteadOf`, `url.*.pushInsteadOf`, `ext::` transports). The
harm is code of the attacker's choosing executing with the operator's credentials at
push time, or the push being redirected.

Out of scope: a compromised trusted session (an operator or executor working on trusted
input); and any command-text matcher on `git config` or similar Bash text, which
DEC-0267 removed and AISDLC-1014 deleted. Two limits disclosed in PR #1211 are the
origin of this task: (a) an untrusted run's pipeline `git push` executes worktree code
(hooks, scripts) with the operator's privileges; (b) `.git/hooks` and `.git/config` are
not protected from an untrusted run.

## Ruling 2026-11-07 (operator, decision rubric)

Option A, untrusted runs only. Same split as GitHub Actions (fork PRs untrusted, same-repo trusted) and git's own trust model; the mitigation is a push-time `core.hooksPath` override, as pre-commit CI mode and depot_tools do. Counter-argument: prompt injection in a trusted worktree is the realistic attack; rebutted because the hooksPath override and trusted hook root apply to every push once built, and only the git-config text matcher, which DEC-0267 removed, is declined. Chosen over a separate threat RFC because the scope fits in this section. AISDLC-663.4 is folded in: its section 1 (trusted hook root) is item 3 below; its section 2 is done since AISDLC-720; its section 3 (Bash text matcher) is rejected under DEC-0267.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "write a threat
RFC first, then the smallest controls" (this task's original AC, planner 2026-10-05); the
threat model now fits in the section above, so no RFC. 2. Deleted: the `git config`
command-text matcher from AISDLC-663.4 section 3 (DEC-0267 / AISDLC-1014) and the separate
threat document. 3. Simplified: one push-time git invocation shape for every pipeline push,
with the override declared in one place, instead of per-hook guards. 4. Accelerated: trusted
pushes see no new prompt and no new step; untrusted pushes skip worktree hooks entirely,
which is also faster. 5. Automated: the protected-path list and the trusted-root resolution
are enforced by the hook and covered by tests; nothing is left to the reviewer's eye.

1. **Push-time override.** Every pipeline push (`pipeline-cli/src/next-step/ship.ts`
   and `pipeline-cli/src/steps/11-push-and-pr.ts`, and any other `git push` the
   pipeline runs on a task branch) runs with an explicit `-c core.hooksPath=<trusted
   path>` pointing at an empty trusted directory or the installed plugin's hook
   directory, never the worktree's `.git/hooks` or `.husky`, plus scrubbed `-c`
   overrides that neutralise the listed keys (`core.sshCommand`, `credential.helper`,
   `url.*.insteadOf`, `url.*.pushInsteadOf`; refuse a remote URL using an `ext::`
   transport). The override is built by one function and declared per AISDLC-1129: the
   change states how `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` are
   handled (unset, scrubbed with `gitSafeEnv()` from
   `scripts/pre-push-patch-coverage.mjs` or an equivalent shared helper, or justified
   when kept), in the PR body and in the function's header comment.
2. **Protected paths.** `.git/hooks/**` and `.git/config` join the untrusted-run
   protected paths in `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (the AISDLC-720
   list that already holds `.ai-sdlc/**`, `.github/workflows/**`, `.claude/**`,
   `.husky/**`, `ai-sdlc-plugin/hooks/**`, `.active-task`), for the worktree's own
   git dir and for a linked worktree's `.git` file target. The refusal message names the
   rule and the next step, in the same shape as the existing one.
3. **Trusted hook root** (from AISDLC-663.4 section 1). The governance hook executes from
   the installed plugin root or the main checkout's copy when running from a worktree; a
   worktree's own copy of `ai-sdlc-plugin/hooks/**` is never executed. Document the
   resolution order in the hook header.
4. **Tests** for each: a push from an untrusted worktree with a planted `.husky/pre-push`
   and a planted `.git/hooks/pre-push` runs neither (hermetic repo with a sentinel
   file); the `-c` overrides are present on the push argv and a configured
   `core.sshCommand` / `url.*.insteadOf` in the worktree config does not take effect;
   writes to `.git/hooks/**` and `.git/config` are refused in an untrusted run and
   allowed in a trusted one; a deliberately modified worktree copy of the hook is not
   the one that runs.

## Velocity impact
Each control states, in the PR body: the harm it prevents, that the happy path (trusted
operator and executor pushes) gets zero new prompts and no new step, and what the agent
does when refused (stop and report the blocked action; no retry with a changed
environment). A control that cannot meet all three is dropped from the task.

## Acceptance Criteria
- [ ] Every pipeline push on a task branch passes an explicit `-c core.hooksPath=<trusted path>` and the scrubbed overrides for the listed keys, built by one function whose header and the PR body state how `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` are handled (AISDLC-1129).
- [ ] A hermetic test shows a planted `.husky/pre-push` and a planted `.git/hooks/pre-push` do not run during the pipeline push, and a worktree `core.sshCommand` or `url.*.insteadOf` does not take effect.
- [ ] `.git/hooks/**` and `.git/config` are refused for an untrusted run by `enforce-blocked-actions.js`, with a test for the refusal and a test that a trusted run is unaffected.
- [ ] A session rooted in a worktree executes the governance hook from the plugin root or the main checkout, never the worktree copy (test with a deliberately modified worktree copy); the hook header documents the resolution order.
- [ ] Local operator and executor sessions keep pushing with zero new prompts (regression test), and no command-text matcher is added.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm test:governance-resolver-gate` and `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
