---
id: AISDLC-1250
title: 'Land the RFC-0049 judgment-config shadow-mode change (AISDLC-641 step 2) through the pipeline so it carries a review verdict'
status: Done
assignee: []
created_date: '2026-11-08'
labels:
  - rfc-0049
  - judgment-layer
  - governance-config
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - backlog/tasks/aisdlc-641 - judgment layer live validation and promotion soak.md
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
dispatchableReason: 'Planner wake 2026-11-08 18:3xZ (DEC-0401 keep-and-automate): PR #2581 was opened by the planner from an operator-run task (AISDLC-641, dispatchable false), so no board verdict exists and only Step 11 of the pipeline may write refs/ai-sdlc/verdicts/<head>; the merge gate refuses it and cli-dispatch reenter refuses a task that is not in done/. The same three-file change runs here as a dispatchable task so the pipeline review round produces the verdict.'
---

## Description

**Gap.** Operator order 2026-11-08 ("turn it on"): the RFC-0049 judgment layer goes live in shadow mode. The planner ran AISDLC-641 steps 1 and 2 and the first step-3 evaluation by hand and opened PR #2581 (head `2b02eadd`, branch `ai-sdlc/aisdlc-641-judgment-config`). The PR fails only the `Review verdict (code PRs)` check: `.ai-sdlc/judgment-config.yaml` is not docs-only, so the gate needs a verdict record under `refs/ai-sdlc/verdicts/<head>`, and only the pipeline's Step 11 writes one. `cli-dispatch reenter 2581` refuses because AISDLC-641 never ran on the board. This task carries the identical change through `/ai-sdlc execute` so the review round and Step 11 run.

**Scope.** Exactly the content of commit `2b02eadd` on `origin/ai-sdlc/aisdlc-641-judgment-config`:
- `.ai-sdlc/judgment-config.yaml`: provider `jev`, model `jev-1.13.0`, every judgment in `shadow`, egress classes `work-item-text`, `code-diff`, `agent-output`.
- `.ai-sdlc/judgment-evals/dor.stage-b-jev-jev-1.13.0-2026-11-08.json`: the first evaluation report, unchanged.
- The AISDLC-641 task file status block from that commit (measured figures and remaining steps), unchanged.

Start with `git cherry-pick 2b02eadd` (or `git checkout 2b02eadd -- <the three paths>`) in the task worktree. Make no other change: no threshold edits, no judgment moved out of `shadow`, no other config file. The runtime reads this file from `origin/main`, so nothing takes effect until the PR lands; `AI_SDLC_JUDGMENT=off` is the kill switch.

**Note for the developer.** The task names `.ai-sdlc/judgment-config.yaml` and `.ai-sdlc/judgment-evals/` as the files and the change, which is what the governance-config rule requires. The reviewers judge the config diff itself: an exact model version, every judgment `shadow`, egress classes limited to the three listed. No RFC open question is touched. PR #2581 stays open for the operator to close once this lands; never close it from the pipeline.

## Fix

**Five-step review (requirements first).**
1. Question: does a planner-made config change need a pipeline review verdict? Yes; the gate reads only `refs/ai-sdlc/verdicts/*` and a hand path would weaken it.
2. Delete: nothing.
3. Simplify: one task, one cherry-pick, no new code.
4. Accelerate: none.
5. Automate: follow-up gap for the wake ledger, not this task: `cli-file` or `cli-dispatch` could offer a review-only round for a planner-opened PR.

## Acceptance Criteria

- [x] AC-1: the task PR diff against `main` equals the diff of `2b02eadd` against its parent for the three paths above, and touches nothing else.
- [x] AC-2: `.ai-sdlc/judgment-config.yaml` on the branch lists every judgment as `shadow` and pins `jev-1.13.0`; `node pipeline-cli/bin/cli-judgment.mjs doctor` (no `--live`) reads it without a schema error.
- [ ] AC-3: the PR carries a verdict record on its head (`Review verdict (code PRs)` passes) and lands through `ai-sdlc/pr-ready`.
- [x] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
The branch carries the content of 2b02eadd: `.ai-sdlc/judgment-config.yaml` (jev-1.13.0, every judgment in shadow), the first evaluation report, and the AISDLC-641 status block. It is rebased onto current origin/main and force-pushed to the existing draft PR #2602. The `Review verdict (code PRs)` check and the `ai-sdlc/pr-ready` rollup have not been checked.

## Changes
- .ai-sdlc/judgment-config.yaml
- .ai-sdlc/judgment-evals/dor.stage-b-jev-jev-1.13.0-2026-11-08.json
- backlog/tasks/aisdlc-641 - judgment layer live validation and promotion soak.md
- .ai-sdlc/reviews/aisdlc-1250.jsonl

## Design decisions
The change was already committed on this branch from an earlier round, so the cherry-pick of 2b02eadd had nothing left to apply. I ran `git cherry-pick --quit` and rebased the two existing commits onto origin/main. The diff against main is the three paths from 2b02eadd, plus the pipeline-written review ledger `.ai-sdlc/reviews/aisdlc-1250.jsonl`. That ledger is an extra file beyond the three paths, so AC-1's 'touches nothing else' is not strictly met unless the ledger is excluded; I left it because the pipeline writes it. The task file's local status edit to In Progress is stashed as `stash@{0}` (tag t1250) and not committed. Without `--live`, `cli-judgment.mjs doctor` ran without a schema error but reported 'judgment layer: disabled'. The runtime reads the config from origin/main, so this is expected until the PR lands. AC-3 (verdict record on the head, landing through `ai-sdlc/pr-ready`) is for Step 11 and the merge gate to confirm.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

