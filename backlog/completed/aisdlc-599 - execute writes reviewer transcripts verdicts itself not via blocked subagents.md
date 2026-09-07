---
id: AISDLC-599
title: >-
  /ai-sdlc execute — coordinator writes reviewer transcripts/verdicts under .ai-sdlc/ itself (reviewer subagents are blocked from it)
status: Done
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
- [x] In a consumer repo, after the 3 reviewers return, `execute` populates `.ai-sdlc/transcripts/` + `.ai-sdlc/verdicts/` itself (Step 7b.5, via `ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh`) and `emit-leaf` finds all three leaves — no reviewer subagent writes under `.ai-sdlc/`.
- [x] The `enforce-blocked-actions.js` `.ai-sdlc/**` Write/Edit block remains in force for subagents (unchanged) — not modified by this task.
- [x] Each reviewer's harness transcript path is resolved by agent-id (`find ~/.claude/projects -name agent-<id>.jsonl`, newest-mtime wins), documented in Step 7b.5 including the `.ai-sdlc/subagent-sessions/<agent-id>.json` marker lookup for obtaining the agent-id.
- [x] `sign-v6` reads the leaves Step 7b.5 + 7c produce with zero manual coordinator file-copies (the helper does all copying).
- [x] Hermetic coverage: `ai-sdlc-plugin/scripts/persist-reviewer-artifacts.test.mjs` (7 cases incl. the negative — missing transcript / missing verdict → non-zero exit). Note: this task did not add a NEW negative test for "subagent attempt to write `.ai-sdlc/` still refused" because that behavior is unchanged and already covered by `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`'s own existing test suite.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Composes with AISDLC-598 (in-process sign consumes these leaves) and AISDLC-600 (runtime pin). This is the produce-side counterpart to the already-fixed verify path (AISDLC-583) and the RFC-0047 independence work (0.23.0).

## Final Summary

Added `ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh`, a coordinator-invoked (via Bash, never Write/Edit) helper that resolves a reviewer's harness-captured transcript by agent-id under `~/.claude/projects/**/subagents/agent-<id>.jsonl` (newest-mtime wins on duplicates) and copies it plus the coordinator-composed verdict JSON into `.ai-sdlc/transcripts/<task>/<agent>.jsonl` and `.ai-sdlc/verdicts/<agent>-<task>.json` — the exact paths `/ai-sdlc execute` Step 7c's `emit-leaf` loop reads. Wired a new Step 7b.5 into `ai-sdlc-plugin/commands/execute.md` between reviewer spawn (7b) and leaf emission (7c) documenting the why (the `.ai-sdlc/**` subagent write-block is absolute and stays that way) and the how (marker-based agent-id resolution + helper invocation per reviewer). Updated Step 7c's missing-file log lines to reflect that a miss is now a real error signal, not an expected skip path. `enforce-blocked-actions.js` was NOT touched. Hermetic coverage in `ai-sdlc-plugin/scripts/persist-reviewer-artifacts.test.mjs` (7 cases) wired into `pnpm test` via `test:persist-reviewer-artifacts-gate`.
