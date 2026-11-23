---
id: AISDLC-1365
title: 'Standalone execute developer first push is refused and its no-PR summary lands in the PR body'
status: Done
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - plugin
  - hooks
  - adopter-trial
dependencies: []
references:
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/agents/agents.test.mjs
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - pipeline-cli/src/hierarchy/lease-preflight.ts
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/ship.test.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/steps/11-push-and-pr.test.ts
  - pipeline-cli/src/steps/10-finalize.ts
  - pipeline-cli/src/steps/10-finalize.test.ts
  - docs/operations/developer-agent-reference.md
priority: medium
---

## Description

**Gap.** In a standalone `/ai-sdlc:execute` session (rooted at the main checkout, no `AI_SDLC_ACTIVE_TASK_ID`, not a hierarchy executor) the developer's first-run push is refused by the PreToolUse hook. The developer then writes "no PR is open" in its summary. When Step 11b opens the PR itself, that sentence becomes the start of the PR body and of the completed task file, and stays there after the PR is merged.

Reference: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2750 (adopter field report, fourth from the same trial as #2736, #2741, #2743).

**Facts read in code** (main at 687e0d596; the files named below are unchanged since the issue's commit except where noted).

- `ai-sdlc-plugin/agents/developer.md:30` requires `git push --force-with-lease -u origin HEAD:refs/heads/<your-branch>` for every push, including the first push of a new branch. `:35` says a failed push must still be attempted and then reported with `prUrl: null`. `:52` assumes the task id is in `AI_SDLC_ACTIVE_TASK_ID`.
- `ai-sdlc-plugin/commands/execute.md` does not mention `AI_SDLC_ACTIVE_TASK_ID` (grep). `:48` and `:144` tell the loop driver that `next-step` pushes with a plain `git push -u`.
- The hook reads the tool call's own cwd (`ai-sdlc-plugin/hooks/enforce-blocked-actions.js:118`). A lone `cd` call does not change it. A `git -C <worktree> push` is resolved only when the command has no pipe or other shell operator (`:156-162`).
- `ai-sdlc-plugin/hooks/lib/trusted-policy.js:358-368` returns the `worktree-location` failure before the task-binding checks. For a session rooted at the main checkout, `:393-407` then needs `AI_SDLC_ACTIVE_TASK_ID` equal to the worktree's `.active-task`, or a hierarchy executor claim.
- The refusal text at `enforce-blocked-actions.js:256-259` suggests "cd <worktree> in a call of its own, then the push by itself", which cannot work because of the cwd rule above.
- Only a force-push shape is refused under the default policy (`enforce-blocked-actions.js:570`). `pipeline-cli/src/hierarchy/lease-preflight.ts:111-115` says an operator running `/ai-sdlc execute` by hand "makes a plain push, which the lease predicate does not govern".
- `pipeline-cli/src/next-step/ship.ts:606-624` reuses an existing PR and otherwise opens one. `pipeline-cli/src/steps/11-push-and-pr.ts:217` puts `developerReturn.summary` first in the body, after any needs-human or `Closes` header. `pipeline-cli/src/steps/10-finalize.ts:107-109` writes the summary and notes verbatim into the completed task file.
- Not covered elsewhere: no commit since the issue touches these paths for this defect (git log over those files shows AISDLC-1363, 1359, 1335, 1326, none about the first-run push), and no backlog task mentions it.

**What the issue reports** (observed in the adopter trial, not reproduced here). In three runs the developer tried nine force-with-lease pushes, all refused with the `worktree-location` condition. It never ran `gh pr create`. Step 11 pushed and opened PR #3, whose body begins "The push was refused by the governance hook, so no PR is open." The task file carries the same claim. The plain-push path is read in source, not run.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: AISDLC-1227 keeps the developer as the first pusher and opener of the draft PR, but Step 11 already pushes and opens the PR when none exists, so a refused developer push loses nothing except an accurate summary. The `--force-with-lease` requirement on a first push is also not needed: a branch the remote does not have yet has nothing to lease against. 2. Deleted: the force flag on the first push of a new branch, and the cd-in-its-own-call advice that cannot work. 3. Simplified or optimised: the developer uses a plain `git push -u origin HEAD:refs/heads/<branch>` while the remote lacks the branch (the rebase happens before the first push, so no history is rewritten), and keeps the lease form only for a branch that already exists remotely. Step 11b marks the developer text as written before the pipeline pushed, whenever it opens the PR itself. 4. Accelerated: the first push passes the hook in a standalone session, so the PR can open from the developer run without a pipeline fallback. 5. Automated: tests cover the allowed plain push, the refusal message and the PR body and task file marker.

- **Developer push rule.** In `developer.md` (Definition of Done item 3 and the step 5 line), say: if `git ls-remote --exit-code --heads origin <branch>` finds nothing, push with `git push -u origin HEAD:refs/heads/<branch>`; if the branch exists, use `--force-with-lease`. Both stay a standalone command, no pipe. Update the matching text in `docs/operations/developer-agent-reference.md` if it repeats the rule.
- **Refusal text.** Replace the "cd in a call of its own" advice in `enforce-blocked-actions.js` with advice that works: a lone `git -C <main>/.worktrees/<task-id> push ...` with no pipe, or binding the session to the task with `AI_SDLC_ACTIVE_TASK_ID`. Do not loosen any condition of the lease predicate.
- **Execute preamble.** `execute.md` says that in a standalone session the developer's push may be refused by the hook, that Step 11 then pushes and opens the PR, and that the developer must report the refusal in `notes` rather than in `summary`.
- **PR body and task file.** When Step 11b opens the PR (no existing PR), `composeBody` in `11-push-and-pr.ts` heads the developer summary with one line: "Developer summary, written before the pipeline pushed this branch:". `10-finalize.ts` adds the same line above the Summary section when the PR was opened by Step 11b. When a PR already existed, nothing changes.

Expected files (14, within the 15 file limit):

- `ai-sdlc-plugin/agents/developer.md`
- `ai-sdlc-plugin/agents/agents.test.mjs`
- `ai-sdlc-plugin/commands/execute.md`
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs`
- `pipeline-cli/src/next-step/ship.ts`
- `pipeline-cli/src/next-step/ship.test.ts`
- `pipeline-cli/src/steps/11-push-and-pr.ts`
- `pipeline-cli/src/steps/11-push-and-pr.test.ts`
- `pipeline-cli/src/steps/10-finalize.ts`
- `pipeline-cli/src/steps/10-finalize.test.ts`
- `docs/operations/developer-agent-reference.md`
- `ai-sdlc-plugin/hooks/lib/trusted-policy.js`
- `pipeline-cli/src/hierarchy/lease-preflight.ts`

Out of scope: changing the `worktree-location` or task-binding conditions, making the hook follow a lone `cd`, allowing piped `git -C` pushes, and changing AISDLC-1227's commit-only rule for resumed rounds.

## Open questions for the operator

**Should the developer keep pushing and opening the PR at all in a standalone session?** Option A: keep it, with the plain first push (this task). Option B: remove push and PR from the developer's Definition of Done everywhere and let Step 11 own them; this deletes the failure class but reverses AISDLC-1227's choice for first runs. Interim value: A. Recommendation: A now; revisit B only if the plain push is refused too in a real standalone run.

**Is the plain push really accepted by the hook?** Read in source only (the hook refuses force shapes only). The developer of this task confirms it with a hook test before changing the agent text; if a plain push is refused, report it and stop, do not loosen the hook.

## Acceptance Criteria

- [ ] #1 A hook test shows a lone plain `git push -u origin HEAD:refs/heads/<branch>` from a worktree cwd in a main-rooted standalone session (no `AI_SDLC_ACTIVE_TASK_ID`) is allowed.
- [ ] #2 `developer.md` tells the developer to push a branch the remote lacks without `--force-with-lease`, and to use the lease form only when the remote already has the branch; `agents.test.mjs` checks both sentences.
- [ ] #3 A hook test shows the refusal for a main-rooted lone force push names `git -C <main>/.worktrees/<task-id> push` (no pipe) and `AI_SDLC_ACTIVE_TASK_ID`, and no longer advises a lone `cd`.
- [ ] #4 A test of `composeBody` shows that when Step 11b opens the PR the summary is headed by the line "written before the pipeline pushed this branch", and that a reused PR body is unchanged.
- [ ] #5 A test of `10-finalize.ts` shows the completed task file carries the same marker when the PR was opened by Step 11b, and not otherwise.
- [ ] #6 `execute.md` states the standalone push behaviour and where the developer reports a refusal, with a test or grep check in the existing prompt tests.
- [ ] #7 No condition of the lease predicate in `trusted-policy.js` is loosened (the existing lease tests pass unchanged).
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
