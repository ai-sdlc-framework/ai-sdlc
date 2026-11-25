---
id: AISDLC-1411
title: 'Auto-enable workflow arms only PRs from merge authors'
status: To Do
assignee: []
created_date: '2026-11-25'
labels:
  - ci
  - governance
  - security
dependencies: []
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - .ai-sdlc/agent-role.yaml
  - .github/workflows/__tests__/fork-pr-safety.test.mjs
  - .github/workflows/__tests__/load-discipline.test.mjs
  - orchestrator/src/cli/commands/init-templates.ts
  - docs/operations/merge-without-queue.md
priority: high
---

## Description

**Five-step review (requirements first).** The requirement, stated by the operator on 2026-11-25: a PR from an outside contributor must not be armed for auto-merge, whether the contributor is a collaborator with write access or unknown. Such a PR waits for a person to review and merge it.

Today `.github/workflows/auto-enable-auto-merge.yml` arms every non-draft PR opened from a branch in this repository, except release-please branches. It never looks at the PR author. Branch protection on `main` requires no approving review, so an armed docs-only PR merges as soon as `ai-sdlc/pr-ready` passes.

On 2026-11-25 a collaborator with write access opened nine PRs from in-repo branches (#2981 to #2988). Each was armed within about ten seconds and merged one to three minutes later, with no review. #2988 put a corrupted name on 13 sign-off rows in 12 RFCs and merged 69 seconds after it opened; #2989 repaired it. The reconciler had marked every one of them `unowned` and routed it to the planner, but that hold only stops the reconciler; the workflow had already armed the PR.

Every other arming path already checks the author: `cli-merge-if-eligible` requires the PR author and the head commit author to be in `governance.mergeAuthors`, and the dispatch landing pass and the reconciler lanes arm through it. The workflow is the only path with no author check.

- **Delete:** deleting the workflow was considered and rejected. Executor task PRs, filing PRs and decision PRs would then be armed only while the dispatch session runs, and DEC-0209 treats dispatch as the backup arm, not the primary.
- **Simplify:** one rule, from the list that already exists. The workflow arms a PR only when its author is in `governance.mergeAuthors` of `.ai-sdlc/agent-role.yaml` on `main`. No second allow-list is added.
- **Accelerate / automate:** not applicable; the check is one API read inside the existing guard step.

This tightens a control. It changes no decision: DEC-0265 (agents arm docs PRs without an operator step) still holds for merge authors.

## Fix

- In the guard step of `auto-enable-auto-merge.yml`, read `governance.mergeAuthors` from `.ai-sdlc/agent-role.yaml` at the base branch through the GitHub contents API. Keep the workflow free of `actions/checkout` (fork-PR safety guard 1); the list must come from `main`, never from the PR head.
- Skip arming, with a log line naming the author, when the PR author is not in that list. The skip covers every trigger, including `synchronize`.
- Fail closed: when the file cannot be read, the list is missing or the list is empty, arm nothing and log why.
- The workflow does not disarm a PR that a person armed by hand; it only declines to arm.
- Apply the same rule to the adopter workflow template in `orchestrator/src/cli/commands/init-templates.ts`.
- Consequences to state in `docs/operations/merge-without-queue.md`:
  - a PR from an author outside `mergeAuthors` is never armed by the workflow and waits for a person;
  - dependabot PRs are no longer armed by the workflow and are armed only by the reconciler's deps lane, which applies its own trust checks;
  - the MCP envelope PR opened by `release.yml` is armed by the workflow only when its PR author is in `mergeAuthors`; record in the PR body which account opens it and whether it is still armed.
- In the same doc, correct the trigger list (it omits `synchronize`).

## Acceptance Criteria

- [ ] #1 A non-draft PR from an in-repo branch whose author is not in `governance.mergeAuthors` is not armed on `opened`, `reopened`, `ready_for_review` or `synchronize`, and the run log names the author and the reason.
- [ ] #2 A PR whose author is in `governance.mergeAuthors` is armed as before.
- [ ] #3 When `.ai-sdlc/agent-role.yaml` cannot be read on the base branch, or `mergeAuthors` is missing or empty, no PR is armed.
- [ ] #4 The workflow still has no `actions/checkout` step and reads the list from the base branch only; `fork-pr-safety.test.mjs` and `load-discipline.test.mjs` pass.
- [ ] #5 A workflow test asserts the author check exists in the guard step and that the arm step is conditional on it.
- [ ] #6 The adopter template in `init-templates.ts` carries the same author check, covered by `init-features.test.ts`.
- [ ] #7 `docs/operations/merge-without-queue.md` states the author rule, the dependabot and envelope-PR consequences, and the full trigger list.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
