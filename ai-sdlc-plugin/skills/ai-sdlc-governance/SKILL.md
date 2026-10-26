---
name: ai-sdlc-governance
description: AI-SDLC project governance rules, workflow expectations, and pre-commit checklist. Loaded automatically at session start.
autoContext: true
---

# AI-SDLC Governance Rules

## Critical Rules — NEVER violate these

1. **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`, rendered into the session hard rules; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** Do not run `git merge` into main or any other merge operation.
2. **Dismiss PR reviews only with documented reason.** You may dismiss reviews when they failed due to infrastructure issues (e.g., API credit exhaustion) or when findings are documented false positives. Always include a clear explanation in the dismissal message. Prefer updating `.ai-sdlc/review-policy.md` for recurring false positives.
3. **NEVER close issues or PRs.** Do not run `gh pr close` or `gh issue close`. The human decides what to close.
4. **NEVER plain force push.** Do not run `git push --force` or `git push -f`. A `--force-with-lease` push after a rebase is governed by `allowForcePush` (DEC-0264): `lease` = any non-protected branch, `leaseOnOwnBranch` (adopter default) = the task's own worktree only, `never` = no lease push. Do it without asking the operator when permitted, and never to `main`/`master`/protected branches.
5. **NEVER delete branches.** Do not run `git branch -D` or `git branch -d`.
6. **NEVER run destructive git operations.** No `git reset --hard`, `git checkout -- .`, `git restore .`.

These rules are also enforced technically via `ai-sdlc-plugin/hooks/enforce-blocked-actions.sh` and `.ai-sdlc/agent-role.yaml` `blockedActions`.

## Pre-Commit Checklist

Before EVERY commit, run these checks and fix any failures:

```bash
pnpm build          # TypeScript compilation — catches type errors
pnpm test           # All tests must pass
pnpm lint           # ESLint — no errors allowed
pnpm format:check   # Prettier — run `pnpm format` to fix
# Coverage is CI-only, not a local gate (AISDLC-726)
```

### Test File Check
Before committing new `.ts` modules, verify:
- Every new `src/**/*.ts` file (not `types.ts`, `index.ts`) has tests somewhere
- Tests can be in a co-located `.test.ts` file OR in another test file that imports it
- Run the relevant tests and confirm they pass before staging

Do NOT rely on CI to catch missing tests — check locally first.

Do NOT commit if any of these fail. Fix the errors first, then commit.

## Git Flow

- **Always rebase** feature branches onto main. Never merge main into a feature branch.
- When updating a feature branch with latest main: `git fetch origin && git rebase origin/main`
- After rebase with conflicts resolved: `git push --force-with-lease origin HEAD:refs/heads/<branch>` (a standalone command with the branch name written literally)
- Never use `gh api pulls/N/update-branch` with merge method.
- Keep commit history linear — no merge commits on feature branches.
- Use conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`

## Workflow

Complete ALL steps of a multi-step task before stopping: research, plan, implement, run the checklist above, commit with a conventional commit, push, open a PR (never merge it outside `cli-merge-if-eligible`), report. If blocked, say which step and why. When review agents post findings: APPROVE with suggestions is ready for merge per `governance.allowMerge`; CHANGES_REQUESTED with critical or major means fix and push again; a false positive means update `.ai-sdlc/review-policy.md`, never dismiss.

Reference material (project structure, cross-harness review variants, PR workflow, testing) lives in [`docs/operations/agent-governance-reference.md`](../../../docs/operations/agent-governance-reference.md).
