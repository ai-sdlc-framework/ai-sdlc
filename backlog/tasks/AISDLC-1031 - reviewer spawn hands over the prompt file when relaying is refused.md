---
id: AISDLC-1031
title: >-
  The execute loop hands a reviewer its prompt by file path, so a model that refuses to relay a long prompt no longer skips the reviewer
status: In Progress
assignee: []
created_date: '2026-10-22'
labels:
  - review
  - root-cause
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/next-step/next-step.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (2026-10-22).** On the second round of AISDLC-1021 (PR #1880) the executor's model refused to relay the two reviewer prompts (about 29,000 characters each) into the `Agent` tool call, so the test and security reviewers never ran, the round produced no push, and the task failed into a planner ruling. The execute command tells the loop driver to pass `prompt` = the contents of each `promptFile` verbatim; a very long verbatim relay is the step the model balks at.

**Root cause.** The reviewer prompt is delivered through the driver model's context twice (read, then re-emitted), which is both costly and the point of refusal. The prompt already lives in a file the reviewer agent can read.

**Five-step review (requirements first).**
1. Requirement questioned: "the driver relays the prompt text verbatim". Replaced by: the driver hands the reviewer a short bootstrap that names the prompt file; the reviewer reads it itself. The diff-binding nonce stays inside the file, unchanged.
2. Delete: the verbatim relay of the full prompt through the driver's context (and its tokens) on every review round.
3. Simplify: `review-prepare` emits, per reviewer, a `bootstrapPrompt` of a few lines ("Read `<promptFile>` with the Read tool and carry out every instruction in it; it contains the review marker you must echo") next to `promptFile`; `execute.md` tells the driver to pass `bootstrapPrompt` as the Agent `prompt`. Reviewer agents already have `Read`.
4. Accelerate: the fallback is the default; no detection of a refusal is needed.
5. Automate: a unit test that `review-prepare` emits `bootstrapPrompt` naming the file and that the nonce marker is in the file, not the bootstrap; `execute.test.mjs` asserts the command text names `bootstrapPrompt`.

**Velocity impact.** Positive: fewer driver tokens per review round and no skipped reviewer on long prompts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `review-prepare` emits a `bootstrapPrompt` per reviewer that names its `promptFile` and carries no diff or nonce text (unit test)
- [ ] #2 `ai-sdlc-plugin/commands/execute.md` instructs the driver to pass `bootstrapPrompt` as the Agent prompt, never the file contents; `execute.test.mjs` asserts it
- [ ] #3 The verdict parsing and nonce check are unchanged and still tested
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
- Manual: one `/ai-sdlc execute` run shows the three reviewers spawned with short prompts and approved verdicts.
