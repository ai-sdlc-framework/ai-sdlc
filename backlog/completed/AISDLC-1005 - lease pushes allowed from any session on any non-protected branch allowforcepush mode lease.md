---
id: AISDLC-1005
title: >-
  Lease pushes are allowed from any session on any non-protected branch: new allowForcePush mode `lease`, this repo switched to it
status: Done
assignee: []
created_date: '2026-10-21'
labels:
  - hierarchy
  - velocity
  - governance
  - root-cause
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - pipeline-cli/src/hierarchy/lease-preflight.ts
  - .ai-sdlc/agent-role.yaml
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-21 13:45Z).** Two docs PRs (#1780, an RFC walkthrough; #1779, a filing branch) sit red only because their CI runs predate a gate fix on main. A fresh push is the only way to get a new `pull_request` event, and the lease-push hook refuses every agent push on those branches: under `allowForcePush: leaseOnOwnBranch` a `--force-with-lease` push is accepted only from a worktree under `.worktrees/` whose directory name, `.active-task` sentinel and `ai-sdlc/<task-id>-*` branch agree with one inflight claim. Docs, filing and RFC branches never satisfy that, so every refresh of such a branch is a hand push by the operator or a re-filed PR (closed PRs are wasted work). The operator never asked for this binding: an agent added it inline while fixing an executor push problem, and it has only added process friction since. The operator ruled: remove the guardrail. Recorded as DEC-0264 (governance weakening, operator-answered).

**Five-step review (requirements first).**
1. Requirement questioned: "a lease push must come from the dispatched task worktree bound to one executor claim". No operator requirement, decision record or incident ever asked for it. The protection that matters is already provided by `--force-with-lease` itself (no clobbering of a head the pusher has not seen) plus the protected-branch refusal (never `main`/`master`/protected). The worktree binding guards against an agent rewriting a branch it did not claim, a case the lease already makes safe and that has never happened in this repo, while it has cost closed PRs and operator hand pushes repeatedly.
2. Delete: for this repository, the task-worktree binding (cwd under `.worktrees/`, `.active-task` sentinel, directory/branch agreement, executor single-claim and hierarchy-role checks) on lease pushes. The planner-filing-branch carve-out planned as a separate task becomes unnecessary and is superseded.
3. Simplify: one new `allowForcePush` value `lease` in `spec.governance` (resolver, trusted-policy, doctor text, hook refusal text, `lease-preflight`): a push is accepted when it is a `git push --force-with-lease` (any explicit refspec or the current branch), the destination is not `main`/`master`/a protected branch, and the command carries no plain `--force`, `+refspec`, `--mirror`, `--delete` or alias/`$` tricks. `leaseOnOwnBranch` keeps its current meaning for adopters and stays the default; `never` unchanged. `.ai-sdlc/agent-role.yaml` of this repo is set to `lease`.
4. Accelerate: a red docs/filing/RFC PR is fixed with one rebase and one push from any session, with no operator hand push, no close, no new PR, no new CI run for a re-filed branch.
5. Automate: none.

**Velocity impact.** Positive: removes the operator from every docs/filing-branch refresh and ends the re-file workaround. Risk accepted by the operator: an agent can lease-push any non-protected branch; `--force-with-lease` still refuses a stale push, and main/protected branches stay refused in every mode.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `spec.governance.allowForcePush: lease` resolves to a new mode `lease` in `governance-resolver.js` and `trusted-policy.js`; the mode and its source show in `/ai-sdlc doctor` output; `leaseOnOwnBranch` and `never` behave exactly as before (existing tests unchanged and green)
- [ ] #2 Under mode `lease`, a `git push --force-with-lease` to any non-protected branch is accepted by the hook from any cwd, including the main checkout and a `.worktrees/file-*` worktree, with any `AI_SDLC_HIERARCHY_ROLE`; hermetic tests in the hook suite and in `lease-preflight` tests
- [ ] #3 Under mode `lease`, a push to `main`, `master` or a configured protected branch, a plain `--force`/`-f`, a `+refspec`, `--mirror`, `--delete`, and an alias or `$`-expansion push are still refused with a refusal text that names the mode
- [ ] #4 `.ai-sdlc/agent-role.yaml` of this repository sets `allowForcePush: lease`; the rendered session hard-rule line (`governance-resolver.js` force-push text) describes the `lease` mode when it is in effect
- [ ] #5 `docs/operations/decision-authority.md` (lease-push section) and the Git Flow bullet of `CLAUDE.md` describe the three modes in one sentence each and cite DEC-0264; `CLAUDE.md` stays under the size budget
- [ ] #6 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/ && pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check && node scripts/check-claude-md-size.test.mjs`
- Manual: from the main checkout, a lease push of a scratch non-protected branch is accepted by the hook; the same spelled against `main` is refused.
