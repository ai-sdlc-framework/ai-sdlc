---
id: AISDLC-218
title: >-
  Reorder /ai-sdlc execute — open PR as draft, sign envelope before flipping to
  ready (1 CI run instead of 2)
status: To Do
assignee: []
created_date: '2026-05-06 17:14'
labels:
  - enhancement
  - ci
  - performance
  - framework-bug
  - pipeline-cli
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Current `/ai-sdlc execute` flow opens the PR before reviewers/attestation complete. CI fires twice per PR:

1. Dev subagent commits + pushes + opens PR → triggers CI run #1
2. CI runs full check suite. `Verify attestation` fails (no envelope at HEAD)
3. Operator spawns 3 reviewers on the open PR
4. Reviewers complete → write verdicts file → push triggers pre-push hook → auto-sign envelope as separate `chore: auto-sign attestation` commit
5. Push includes envelope chore commit → triggers CI run #2 (same checks except attestation now passes)

Both runs do identical work for build/test/coverage/lint. ~5-10 min × 2 = 10-20 min wasted CI per PR + reviewer cost spent on a sha that won't be the final HEAD.

Observed in the 2026-05-06 autopilot session across 6+ PRs (#346, #348, #350, #351, #352, #353, #355, #356, #358, #359, #363, #364, #365). Every single PR went through the 2-CI-run cycle.

## Operator preference: draft PR approach

The dev should:
1. Commit work locally
2. Push branch (no CI fires — workflows are gated on `pull_request` events with `if: !github.event.pull_request.draft`)
3. Run `gh pr create --draft` with the dev's crafted title + body (preserves authorship)
4. Return the draft PR URL + commit SHA

Then operator:
5. Spawns 3 reviewers using `gh pr diff` on the draft
6. Reviewers complete → write verdicts file → push triggers pre-push hook → auto-sign envelope
7. Re-push (envelope at HEAD)
8. `gh pr ready <pr>` flips draft → ready → triggers CI ONCE on the complete state

## Workflow audit needed

This requires verifying that ALL relevant workflows skip draft PRs. Today's workflows fire on `pull_request: [opened, synchronize, reopened]` regardless of draft state. Need to add `if: !github.event.pull_request.draft` to each workflow's job-level condition (or move to `pull_request: [ready_for_review, synchronize, reopened]`).

Workflows to audit:
- `ai-sdlc-review.yml`
- `verify-attestation.yml`
- `ai-sdlc-gate.yml` (rollup)
- `ci.yml`
- `coverage` workflow
- `backlog-drift` workflow
- `verify-bundle` workflow
- `lint-format` workflow

## Implementation

1. Update `ai-sdlc-plugin/commands/execute.md` Step 11 (push) + Step 12 (PR open):
   - Step 11a: dev pushes branch (no PR yet)
   - Step 11b: dev runs `gh pr create --draft` — crafts title/body
   - Step 12: operator runs reviewers + sign envelope
   - Step 13: `gh pr ready` flips draft → ready
2. Update `developer` agent definition to default to `--draft` when invoking `gh pr create` (or have the slash command handle it)
3. Update workflows to skip drafts (job-level `if: !github.event.pull_request.draft` or trigger swap to `[ready_for_review, synchronize, reopened]`)
4. Hermetic test: simulate full pipeline run, assert CI fires exactly once (on ready_for_review transition)

## Cost / time savings

- **CI minutes**: ~50% reduction per PR
- **Wall-clock per PR**: ~10-20 min faster
- **Reviewer billing**: 0% saved (reviewers run once either way) but they review the FINAL sha
- **Operator notification noise**: one "CI passed" instead of "CI failed → re-pushed → CI passed"

## Acceptance Criteria

- [ ] #1 Dev subagent / `/ai-sdlc execute` opens PRs as draft via `gh pr create --draft`
- [ ] #2 Slash command body Step 11/12/13 reordered: push → draft PR → reviewers + sign → `gh pr ready`
- [ ] #3 All required-check workflows skip draft PRs (job-level `if: !github.event.pull_request.draft` OR trigger swapped to `[ready_for_review, synchronize, reopened]`)
- [ ] #4 Hermetic test confirms CI fires exactly once per PR (on the ready_for_review transition)
- [ ] #5 Documentation in CLAUDE.md `## Hooks` and the slash command body updated to reflect the draft-then-ready pattern
- [ ] #6 Operator runbook entry on `/ai-sdlc execute` flow updated
<!-- SECTION:DESCRIPTION:END -->
