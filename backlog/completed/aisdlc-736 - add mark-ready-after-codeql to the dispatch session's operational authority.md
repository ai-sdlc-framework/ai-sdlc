---
id: AISDLC-736
title: >-
  Add mark-ready-after-codeql to the dispatch session's operational authority
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - governance
  - config
dependencies: []
references:
  - .ai-sdlc/agent-role.yaml
  - spec/schemas/agent-role.schema.json
  - sdk-go/core/schemas/agent-role.schema.json
  - pipeline-cli/src/hierarchy/operational.ts
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - docs/api-reference/governance.md
  - .github/workflows/auto-enable-auto-merge.yml
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DEC-0062 (recorded in PR #1225) lets the dispatch session mark a draft PR ready with `gh pr ready` when the PR body says it is draft until CodeQL is clean, and every Analyze job on the head has passed. A failed Analyze job goes back to an executor as a fix round. Arming follows automatically from `.github/workflows/auto-enable-auto-merge.yml`, which fires on `ready_for_review`.

The dispatch session's operational list lives in `.ai-sdlc/agent-role.yaml` under `spec.operational` (today: `rebase-own-branch`, `lease-push-own-branch`, `retrigger-ci`, `requeue`, `file-subid-followups`, `answer-operational-decisions`, `clear-executor-context`). The closed set is mirrored in `spec/schemas/agent-role.schema.json` (enum), `sdk-go/core/schemas/agent-role.schema.json`, `pipeline-cli/src/hierarchy/operational.ts`, `ai-sdlc-plugin/hooks/lib/governance-resolver.js` and `docs/api-reference/governance.md`. DEC-0062 needs the new entry in all of them, or an unknown entry is dropped and not granted.

Velocity impact: zero prompts on the happy path, and it removes a wait on a person for every PR that is held as draft until CodeQL is clean. The exit for a failed Analyze job is an executor fix round, never a human.

Sequencing: the entry grants authority only. It does not relax any hook, and arming stays with the workflow.

Out of scope: any other change to `spec.operational`, to hooks, or to the auto-merge workflow.

## Acceptance Criteria
- [x] The entry `mark-ready-after-codeql` is added to `spec.operational` in `.ai-sdlc/agent-role.yaml`, next to the existing entries, and to every mirror of the closed set listed above, each with a one-line description (where the file carries descriptions).
- [x] `ai-sdlc-plugin/commands/operator-dispatch.md` names the rule in its tick: mark a draft PR ready only when its body says draft until CodeQL is clean and every Analyze job on the head passed; a failed Analyze job goes back to an executor as a fix round; never arm by hand.
- [x] The schema enum and the resolver list accept the entry, and a test covers it (`pipeline-cli/src/hierarchy/operational.test.ts` and the governance resolver or schema validation test): the entry is granted when listed and still dropped when misspelled.
- [x] The rule never flips a PR whose body or a comment marks it as superseded by another PR, or whose branch is DIRTY (conflicting with main); such PRs are listed in the tick output for the operator to close. Reason: marking a dead PR ready would arm auto-merge on it (#1202 on 2026-10-06).
- [x] No skip variable and no hook exception is used to make the edit; if the installed hook refuses an edit, the refusal text goes in the PR body and the task stops.
- [x] Velocity impact paragraph in the PR body: zero prompts, removes a wait on a person.
<!-- SECTION:DESCRIPTION:END -->
