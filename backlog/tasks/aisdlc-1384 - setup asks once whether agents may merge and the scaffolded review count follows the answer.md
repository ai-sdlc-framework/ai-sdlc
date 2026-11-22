---
id: AISDLC-1384
title: 'Setup asks once whether agents may merge, and the scaffolded review count follows the answer'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - init
  - adopter
  - governance
dependencies: []
references:
  - pipeline-cli/src/config-manifest/manifest.ts
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - orchestrator/src/cli/commands/doctor.ts
  - ai-sdlc-plugin/commands/setup.md
priority: high
---

## Description

**Gap.** AISDLC-1351 and AISDLC-1353 shipped interim values for two operator questions. A new adopter gets `allowMerge: never` with empty `mergeAuthors` and `operational` (`AGENT_ROLE_MERGE_DEFAULTS`, `pipeline-cli/src/config-manifest/manifest.ts:90-98`), and branch protection that requires 1 approving review (`REQUIRED_APPROVING_REVIEW_COUNT = 1`, `orchestrator/src/cli/commands/branch-protection-shared.ts:102`). Nothing posts approvals any more (the approve job was retired with the signed envelopes, DEC-0284), and GitHub does not let an author approve their own pull request. So a solo adopter's pull requests never land without hand edits or an admin bypass. That breaks the operator requirement of 2026-11-19: bootstrap once, and everything is configured and running.

**Decisions (operator, 2026-11-22).**
- DEC-0424, option `setup-asks`: setup asks once whether agents may merge pull requests that pass every gate. Yes writes `allowMerge: onGreenClean` with the authenticated `gh` login as the only `mergeAuthors` entry. No, or no answer (a non-interactive run), writes `never` and keeps the loud line from AISDLC-1351.
- DEC-0425, option `follow-merge`: the scaffolded required approving review count is 0 when `allowMerge` is `onGreenClean` (the verdict gate `ai-sdlc/pr-ready` is the review control) and 1 when it is `never`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the adopter must choose agent merging explicitly, and the review control must be one the adopter can satisfy. 2. Deleted: the fixed review count of 1 for every adopter. 3. Simplified: one answer drives both values, so the two cannot disagree. 4. Accelerated: a yes at setup gives a board that lands its first pull request with no hand edit. 5. Automated: tests below, plus doctor checks the pair.

- **Setup question.** `ai-sdlc-plugin/commands/setup.md` asks one yes/no question before init writes `agent-role.yaml`: "Let agents merge pull requests that pass every gate (green checks, clean merge state, review verdict)?" The answer goes to init as a flag (for example `--agent-merge yes|no`). With no flag, init writes the `never` values, as today.
- **Yes.** `agent-role.yaml` gets `allowMerge: onGreenClean`, `mergeAuthors: [<gh api user login>]` and an `operational` list that contains `land-eligible-prs`, because the landing pass runs only when `operational` holds it (`pipeline-cli/src/hierarchy/dispatch-loop.ts`). If the `gh` login cannot be read, init writes `never` and prints one line saying why. It never writes `onGreenClean` with an empty author list.
- **Review count.** The count is derived from the answer: 0 for yes, 1 otherwise. `REQUIRED_APPROVING_REVIEW_COUNT` becomes a function of the merge setting. The setup summary prints the count and why ("0: the verdict gate ai-sdlc/pr-ready is the review control" or "1: a human approval is required; you cannot approve your own pull requests"), and says a team may raise it.
- **Doctor.** `requiresApprovingReview` (`orchestrator/src/cli/commands/doctor.ts:77`, `branch-protection-shared.ts:215`) passes on a count of 0 only when the resolved `allowMerge` is `onGreenClean` and `ai-sdlc/pr-ready` is a required context. Otherwise it keeps requiring 1 or more. It names the pairing in its message.
- **Re-run.** Re-running setup or init never changes an existing `agent-role.yaml` merge block or an existing protection count without an explicit flag. It prints the current values.

## Acceptance Criteria

- [ ] #1 A test: init with `--agent-merge yes` and a readable gh login writes `onGreenClean`, that login as the only merge author, `land-eligible-prs` in `operational`, and branch protection with a review count of 0.
- [ ] #2 A test: init with `--agent-merge no`, or with no flag, writes `never`, empty lists, and a review count of 1.
- [ ] #3 A test: `--agent-merge yes` with no readable gh login writes `never` and prints the reason.
- [ ] #4 A test: doctor passes a count of 0 with `onGreenClean` and `ai-sdlc/pr-ready` required, and fails a count of 0 with `never`.
- [ ] #5 A test: re-running init on a repository with an existing merge block leaves it unchanged without a flag.
- [ ] #6 `setup.md` asks the question and passes the flag; the setup summary prints both values with the reason.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
