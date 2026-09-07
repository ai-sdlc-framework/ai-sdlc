---
id: AISDLC-599
title: >-
  /ai-sdlc execute — coordinator writes reviewer transcripts/verdicts under .ai-sdlc/ itself (reviewer subagents are blocked from it)
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - pipeline-cli
  - execute
  - attestation
  - governance
  - adopter
  - consumer-produce
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - pipeline-cli/bin/cli-attestation.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Gap 2 of the consumer-produce triage (2026-09-07, `/ai-sdlc execute LT-469` in local-trades).**

Step 7c of `execute` reads each reviewer's transcript from `<worktree>/.ai-sdlc/transcripts/<task>/<agent>.jsonl` and verdict from `<worktree>/.ai-sdlc/verdicts/<agent>-<task>.json`, then `emit-leaf`s them so `sign-v6` has leaves to sign. Those files are meant to be written by the reviewer subagents.

But the plugin's OWN `enforce-blocked-actions.js` PreToolUse hook **hard-refuses any Write/Edit under `.ai-sdlc/**` — including from the reviewer subagents `execute` just spawned.** So in a consumer repo the reviewers cannot write their transcript/verdict to the path Step 7c reads → `emit-leaf` finds nothing → no leaves → `sign-v6` has nothing to sign.

The manual consumer workaround proven in local-trades: the reviewer's real transcript is the harness-captured `~/.claude/projects/<proj>/subagents/agent-<id>.jsonl`; the coordinator (main session, exempt from the subagent write-block) copies it into `<worktree>/.ai-sdlc/transcripts/...` via `cp` (Bash `cp` is permitted — governance blocks the Write/Edit *tools*, not the shell) and writes the verdict JSON, then `emit-leaf`s. That is what `execute` should do natively.

## Scope
- After the reviewer subagents return, have `execute` (the main session, exempt from the subagent `.ai-sdlc/**` write-block) itself:
  - copy each reviewer's harness-captured transcript (`~/.claude/projects/<proj>/subagents/agent-<id>.jsonl`) into `<worktree>/.ai-sdlc/transcripts/<task>/<agent>.jsonl`, and
  - write each verdict JSON to `<worktree>/.ai-sdlc/verdicts/<agent>-<task>.json`,
  before `emit-leaf`. Do NOT rely on reviewer subagents to write under `.ai-sdlc/`.
- Resolve each spawned reviewer's harness transcript path reliably (map agent-id → `subagents/agent-<id>.jsonl`), including the worktree project-dir topology `execute` uses. (Coordinate with the separately-filed `emit-leaf` worktree-topology issue that derives the wrong Claude project dir → `harnessTranscriptHash=null`.)
- Preferred over narrowly exempting `.ai-sdlc/transcripts/` + `.ai-sdlc/verdicts/` from the subagent write-block (option b in the triage): keeping the config-dir write-block absolute is the safer governance posture, and coordinator-writes matches how a consumer coordinator has to do it anyway. If option (b) is chosen instead, the exemption MUST be narrow (those two subtrees only) and justified.

## Acceptance Criteria
- [ ] In a consumer repo, after the 3 reviewers return, `execute` populates `.ai-sdlc/transcripts/` + `.ai-sdlc/verdicts/` itself and `emit-leaf` finds all three leaves — no reviewer subagent writes under `.ai-sdlc/`.
- [ ] The `enforce-blocked-actions.js` `.ai-sdlc/**` Write/Edit block remains in force for subagents (unchanged), OR (if option b) is narrowed to exactly the two produce subtrees with a documented rationale.
- [ ] Each reviewer's harness transcript path is resolved correctly under the worktree topology `execute` uses (no `harnessTranscriptHash=null` from a mis-derived project dir).
- [ ] `sign-v6` signs a 3-leaf envelope that `verify-attestation` accepts, produced with zero manual coordinator file-copies.
- [ ] Hermetic/integration coverage for the coordinator-writes path incl. the negative (subagent attempt to write `.ai-sdlc/` still refused).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Composes with AISDLC-598 (in-process sign consumes these leaves) and AISDLC-600 (runtime pin). This is the produce-side counterpart to the already-fixed verify path (AISDLC-583) and the RFC-0047 independence work (0.23.0).
