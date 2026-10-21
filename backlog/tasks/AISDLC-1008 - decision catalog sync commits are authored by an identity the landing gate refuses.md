---
id: AISDLC-1008
title: >-
  Decision-catalog sync commits are authored by an identity the landing gate refuses, so every sync PR needs a human
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - governance
  - decisions
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/decisions/remote-persist.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - docs/operations/merge-without-queue.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-21 17:30Z, from an adopter report).** `remote-persist.ts` authors the decision-catalog sync commit as `ai-sdlc-decisions <decisions@ai-sdlc.invalid>`. The landing gate in `merge-if-eligible.ts` refuses any head commit whose author is not linked to a GitHub account on the `mergeAuthors` allow-list. One component produces commits the other refuses by design, so a sync PR can never land on its own: in this repo #1813 is open with the same shape, and in an adopter repo the sync PR was re-raised three times, re-authored by hand and closed by hand. Operator principle: humans inside process loops are a source of error; they belong at quality decisions, not at landing steps.

**Five-step review (requirements first).**
1. Requirement questioned: "the sync commit carries a synthetic bot identity". Nothing consumes that identity; the only effect is that the gate refuses it. The gate's author check exists to keep untrusted commits out, and a commit the CLI itself authored from the operator's own checkout is as trusted as any filing PR from `cli-file`, which already uses the configured git identity.
2. Delete: the synthetic `ai-sdlc-decisions` identity.
3. Simplify: the sync commit uses the repository's configured git identity (the same one `cli-file` uses), so the existing author check passes with no new exemption. The `decisions-sync` source kind keeps its branch-name check; no content-hash bypass is added.
4. Accelerate: a sync PR lands on green in the same tick that opened it.
5. Automate: none beyond the above.

**Velocity impact.** Positive: removes one hand-landed PR per decision batch and the duplicate-PR cleanup that followed it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The commit written by `remote-persist.ts` has the author and committer of the repository's configured git identity (`git config user.name/user.email`), with no synthetic identity anywhere in the module; unit test asserts the author arguments passed to git
- [ ] #2 A sync PR authored this way passes `cli-merge-if-eligible <pr> --source-kind decisions-sync --dry-run` in the gate's tests (head-commit author resolves to an allow-listed login); the branch-name check is unchanged
- [ ] #3 `docs/operations/merge-without-queue.md` states that the sync commit uses the operator's git identity and why
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
