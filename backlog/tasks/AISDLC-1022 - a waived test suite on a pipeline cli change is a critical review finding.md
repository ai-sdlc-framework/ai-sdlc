---
id: AISDLC-1022
title: >-
  A waived test suite on a change under `pipeline-cli/src` is a critical review finding and a governance-gate failure
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - governance
  - root-cause
  - review
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - ai-sdlc-plugin/agents/correctness-reviewer.md
  - scripts/check-pr-governance.mjs
  - docs/operations/prompt-rules.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (RCA of the 2026-10-21 Step 10.5 outage).** The PR that added a hard-fail check to Step 10.5 recorded `pnpm test` as waived in its task summary, carried tests that stub every git call, and was approved in two rounds by the correctness and security reviewers. Neither verdict mentioned the waiver. The change broke every later task on the executors.

**Root cause.** Nothing in the review set or the gates treats "tests were not run" on the code that runs the pipeline as a blocking fact.

**Five-step review (requirements first).**
1. Requirement questioned: "a developer may waive the suite when the host is slow". Kept for docs and plugin prose; removed for `pipeline-cli/src`, `orchestrator/src` and `ai-sdlc-plugin/hooks`, the code every executor runs next.
2. Delete: nothing to delete.
3. Simplify: one prompt rule in `prompt-rules.js` (rendered into the correctness reviewer and the developer) says a waived or skipped `pnpm test` on a change touching those paths is a critical finding, and the developer's return notes must state the exact test command run and its summary line.
4. Accelerate: `scripts/check-pr-governance.mjs` fails the governance-gate job when the PR's task file (moved to `backlog/completed/` in the same PR) records the suite as waived or skipped while the diff touches those paths.
5. Automate: a hook test for the rendered rule and a unit test for the gate check.

**Velocity impact.** Neutral for honest runs; a waiver on pipeline code becomes a visible stop instead of a day-long outage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `prompt-rules.js` defines one rule, rendered into `correctness-reviewer.md` (and its codex variant) and `developer.md`, that a waived or skipped test suite on a change under `pipeline-cli/src`, `orchestrator/src` or `ai-sdlc-plugin/hooks` is a critical finding
- [ ] #2 `check-pr-governance.mjs` fails when the completed task file in the PR records `pnpm test` as waived or skipped and the diff touches those paths (unit test with both a failing and a passing fixture)
- [ ] #3 `docs/operations/prompt-rules.md` lists the new rule id
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/*.test.js`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
