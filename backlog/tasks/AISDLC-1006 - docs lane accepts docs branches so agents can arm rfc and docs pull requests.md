---
id: AISDLC-1006
title: >-
  Docs lane of merge-if-eligible accepts `docs/*` head branches so agents can arm RFC and docs PRs
status: To Do
assignee: []
created_date: '2026-10-21'
labels:
  - governance
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - docs/operations/merge-without-queue.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-21 17:20Z).** PR #1780 (an RFC open-question walkthrough on branch `docs/rfc-0056-oq-walkthrough`) could not be armed by dispatch: `cli-merge-if-eligible 1780 --source-kind docs --arm` refused with `docs-lane landing is limited to "ai-sdlc/file-*"`, and the `backlog` kind refuses because no task id derives from the branch. Every RFC walkthrough, RFC filing and docs correction in this repository lands from a `docs/*` branch, so each one is either armed by the operator by hand or waits for the `auto-enable-auto-merge.yml` workflow to happen to catch it. The operator chose to widen the lane (DEC-0265): the docs source kind also accepts `docs/*` heads under the same trusted-author, green and CLEAN gates.

**Five-step review (requirements first).**
1. Requirement questioned: "docs-lane landing is limited to `ai-sdlc/file-*` heads". The prefix was chosen when the only docs-lane caller was `cli-file`; it was never meant to exclude RFC and docs branches. The real controls of the lane are the author allow-list, the green `ai-sdlc/pr-ready` rollup and `mergeStateStatus == CLEAN`, and those stay as they are.
2. Delete: the operator hand-arm step for every RFC and docs PR.
3. Simplify: `DOCS_LANE_HEAD_PREFIX` becomes a short list of accepted prefixes (`ai-sdlc/file-`, `docs/`); the refusal text names the list. No new flag, no new source kind.
4. Accelerate: an RFC or docs PR is armed by dispatch in the same tick that reconciles it, and lands on green with no human step.
5. Automate: none.

**Velocity impact.** Positive: removes one operator action per RFC and docs PR. Risk: a `docs/*` branch could carry code; the attestation gate still classifies by changed files, so a code change on a `docs/*` branch is still a code PR for `ai-sdlc/pr-ready` and does not land without its envelope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `--source-kind docs` accepts a PR whose head branch starts with `ai-sdlc/file-` or `docs/` and refuses any other head with a message naming both prefixes; unit tests cover `docs/rfc-0056-oq-walkthrough`, `ai-sdlc/file-aisdlc-975` (accepted) and `feat/x`, `ai-sdlc/aisdlc-1-x` (refused under the docs kind)
- [ ] #2 The author allow-list, green rollup and CLEAN checks are unchanged for the docs kind (existing tests pass unmodified)
- [ ] #3 `docs/operations/merge-without-queue.md` states the accepted docs-lane prefixes and cites DEC-0265
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
