---
id: AISDLC-418
title: >-
  feat(orchestrator): augment /ai-sdlc orchestrator-tick with autonomous
  reconcile sub-tick + reviewer-pass caching
status: Done
assignee:
  - '@claude-opus-4-7'
created_date: '2026-05-24 05:47'
updated_date: '2026-05-24 16:30'
labels:
  - orchestrator
  - automation
  - pattern-x
  - rfc-0041
  - reviewer-cache
dependencies: []
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - >-
    backlog/completed/aisdlc-182 -
    CLI-add-ai-sdlc-pipeline-execute-umbrella-subcommand-for-end-to-end-Step-0-13-dispatch.md
  - >-
    backlog/completed/aisdlc-373 -
    feat-collapse-two-pr-pattern-task-file-and-implementation-in-single-pr.md
  - >-
    backlog/completed/aisdlc-396 -
    feat-orchestrator-tick-dispatches-dev-via-in-session-background-agent.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/execute/index.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`/ai-sdlc orchestrator-tick` correctly runs the first part of the pipeline (Steps 1-12: implementation, push, draft PR) inside the dev's own background session — that's by design (Pattern X v2, AISDLC-396). What's **missing** is the second part: **the rest of the steps (3.3-3.8: reviewers + sign + push attestation + flip ready) should run autonomously in a subsequent tick that orchestrator initiates, NOT manually driven by Claude in the slash body.**

Tonight's AISDLC-344 reconcile burned ~5K context tokens on 6+ manual Bash calls (write verdict, salvage transcripts from /private/tmp, emit leaves, sign v6, stage, commit, rebase, force-push, gh pr ready, gh pr merge --auto, remove done/verdict). The skill body PROMPTS me through these, but they're still my hands on the wheel. Operator complaint 2026-05-23:

> "I thought we decided to wire into the orchistrator a process to dispatch the reviewers instead of manually having to drive that part."

The architecture is correct in spirit (orchestrator handles dispatch + reconcile). The gap is operational: reconcile is a sequence of bash commands that I copy-paste from the skill body. It should be a **single autonomous sub-tick** that orchestrator initiates when a dev returns.

## What the augmentation looks like

Add a **reconcile sub-tick** that orchestrator-tick initiates when Phase A pairs a completion notification with a pending sentinel. The reconcile sub-tick:

1. Reads the dev's return envelope (commitSha, prUrl, pushedBranch, verifications)
2. Spawns the 3 reviewer subagents in parallel from the main session (foreground Agent calls — only place `Agent` works)
3. Aggregates verdicts → writes `.ai-sdlc/verdicts/<task-id>.json`
4. Emits transcript leaves (v6 prereq) — salvages from /private/tmp Agent output files if not already in worktree's transcripts/
5. Signs v6 attestation
6. Force-pushes attestation chore on top of dev's branch
7. Flips draft → ready
8. Arms auto-merge
9. Removes consumed verdict

Today this is 6+ separate Bash commands that I orchestrate by reading the skill body. The augmentation makes it `ai-sdlc-pipeline reconcile <task-id>` (or equivalent) — one bash call invoked by orchestrator-tick's Phase A reconcile branch.

## Reviewer-pass caching (operator add-on)

**If a reviewer approved in a previous tick, don't re-run it on a subsequent tick.** This matters when:

- The dev returns iterate-needed (round 2) and we re-dispatch with feedback
- The previous round's reviewers already APPROVED with no findings on a stable file subset
- Only re-run reviewers whose diff-coverage changed (i.e., re-run reviewers for files touched in the new iteration; cache passes for untouched files)

Implementation sketch (for spec phase):
- Persist per-reviewer verdict + file-coverage fingerprint to `.ai-sdlc/verdicts/cache/<task-id>/<reviewer>.json`
- On re-dispatch: for each reviewer, compute diff of files-changed between this iteration and the cached verdict's coverage; if no overlap, reuse cached verdict
- Cache invalidates on: (a) any file the reviewer flagged changes, (b) cache TTL (e.g., 24h to avoid stale cross-RFC review drift), (c) reviewer agent code/prompt changes (hash the agent .md file)

This avoids re-running expensive security-Opus reviews on iterate-needed retries when only the unrelated MAJOR finding was fixed.

## What's NOT being asked

- DO NOT change the Pattern X v2 split (orchestrator-tick dispatches bg dev; dev does Steps 1-12; orchestrator reconciles). That architecture is correct.
- DO NOT collapse onto `ai-sdlc-pipeline execute` (the umbrella). The umbrella runs everything in one Node process — incompatible with Pattern X v2's bg Agent + sentinel handoff.
- DO NOT touch `cli-orchestrator tick` (TS service path) — already wired correctly per AISDLC-373.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Reconcile sub-tick implemented as a single command (e.g. `ai-sdlc-pipeline reconcile <task-id>`) wrapping current skill-body Steps 3.3-3.8; orchestrator-tick Phase A invokes it once per paired completion, no manual Bash composition by Claude
- [x] #2 Reviewer fan-out within reconcile sub-tick still happens in main session (Agent tool only available there) but invoked AS ONE OPERATION, not 3+ separate calls
- [x] #3 Transcript-leaf salvage automated: if reviewer transcripts aren't in worktree's .ai-sdlc/transcripts/, reconcile sub-tick finds them via Agent ID → /private/tmp lookup and copies in before emit-leaf
- [x] #4 Reviewer-pass cache implemented at .ai-sdlc/verdicts/cache/<task-id>/<reviewer>.json; iterate-needed re-dispatch skips reviewers whose coverage didn't change
- [x] #5 Cache invalidation triggers documented + enforced: file-touched overlap, TTL, reviewer-agent file hash
- [ ] #6 Operator-validated end-to-end: real frontier task dispatched + iterated through Pattern X v2 hits reconcile sub-tick exactly once per iteration; round-2 retry only re-runs reviewers whose coverage changed
- [x] #7 Skill body (ai-sdlc-plugin/commands/orchestrator-tick.md) Step 3 prose updated: invoke `ai-sdlc-pipeline reconcile <task-id>` instead of the current 6-step Bash recipe

## Source

Operator session 2026-05-23, post-AISDLC-344 reconcile. Clarification: "the orchestrator tick was designed to run the first part of the steps the only part is to augment it to finish the rest of the steps in another tick that you can initiate as needed, that does the rest of the part without you having to manually drive it. we should also take into consideration if a reviewer has passed in a previous tick we shouldn't need to re-run it and subsequent tick."

## Composes with

- AISDLC-NEW (#237 in this session's task list): reconcile-CLI wrapper — this task SUPERSEDES that one; the reconcile sub-tick IS the wrapper plus the caching layer
- AISDLC-396 Pattern X v2: keep the bg Agent + sentinel handoff intact
<!-- SECTION:DESCRIPTION:END -->

<!-- AC:END -->
<!-- AC:END -->
