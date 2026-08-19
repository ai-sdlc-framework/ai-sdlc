---
id: AISDLC-564
title: >-
  feat(dispatch): persist the agent recovery key so a killed subagent can be
  resumed after the dispatching session loses context
status: To Do
assignee: []
labels:
  - dispatch
  - orchestrator
  - reliability
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - docs/operations/dispatched-session-decisions.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A dispatched developer subagent can be killed mid-flight by a session/usage
limit. **Recovery already works** — `SendMessage <agentId>` resumes the agent
from its transcript with reasoning context intact, verified twice on 2026-08-18.
The gap is narrower than it looks: **the recovery key is not persisted
anywhere durable.**

`agentId` exists only in the dispatching conversation's context. Nothing in
`.ai-sdlc/` or `backlog/` maps a task to its agent — confirmed by grep. So if
the dispatching session compacts hard, crashes, or simply ends, the situation
is:

- the agent's full transcript still exists (the harness writes it — the
  AISDLC-555 dev's was **1.5 MB**), but it sits under a session-scoped
  `/private/tmp/...` path that is eventually cleared;
- nothing records which agent was working which task, which worktree it owned,
  or that it stopped with uncommitted work;
- so a resumable agent becomes unrecoverable for want of a 17-character string.

### Evidence

Two developer subagents hit the limit on 2026-08-18. The first (AISDLC-559
fixes) had made no changes — verified by `git status` in its worktree. The
second (AISDLC-555) died with **791 lines across 7 files uncommitted**,
including the entire `check-attestation-sign.sh` deliverable. Both were
recoverable only because the dispatching session still held their IDs in
context.

### Scope

Extend the EXISTING per-task session record rather than inventing a store.
`.ai-sdlc/dispatch/sessions/<task-id>.session.json` already carries
`schemaVersion`, `taskId`, `spawnedAt`, `status`, `lastHeartbeat`, plus
spawner-specific fields (`tmuxSession`, `tmuxWindow`, `paneId`) for the tmux
path. Add the equivalent fields for the in-session-agent path:

- `agentId` — the recovery key
- `transcriptPath` — where the harness wrote the transcript
- `worktreePath` — which worktree the agent owns, so its uncommitted state is
  findable without guessing

Write the record at dispatch, update `status` on completion or failure. A
future operator (or a fresh session) should be able to read the board and know
what to resume and where its work is.

### Deliberately OUT of scope

- **Do not build a context/transcript log.** The harness already writes a
  full JSONL transcript per agent, 1.5 MB in the observed case. Duplicating it
  would cost storage and tokens and buy nothing — the transcript is not what
  goes missing, the pointer to it is.
- **Do not add incremental/periodic commits to the developer contract.** This
  was considered and **declined by the operator on 2026-08-18**: unnecessary
  commits landing purely for frequency is a worse cost than the recovery
  benefit. Do not reintroduce it as a "helpful" addition.
- Do not attempt to auto-resume. Detecting the kill and deciding whether to
  resume is a judgement call; this task only makes the decision *possible*.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Dispatching a developer subagent writes a session record containing
      `agentId`, `transcriptPath` and `worktreePath` alongside the existing
      fields
- [ ] #2 The record's `status` reflects completion or failure, so a stale
      in-progress entry is distinguishable from a finished one
- [ ] #3 Given only the repo (no conversation context), an operator can
      identify which agent owned a task and which worktree holds its work
- [ ] #4 The addition is backward-compatible with existing tmux-path records —
      `schemaVersion` handling covers records lacking the new fields
- [ ] #5 Hermetic tests cover write-on-dispatch, status update, and reading a
      legacy record without the new fields
- [ ] #6 No transcript content is copied into the repo — only the path
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The observed failure mode is upstream (a session limit terminating a subagent,
with no auto-resume on reset) and is not worth working around in this repo.
This task addresses only the part that is ours: the recovery key living in
volatile conversation context instead of on the dispatch board that already
exists for exactly this kind of state.

Check whether `.ai-sdlc/dispatch/sessions/` is gitignored before deciding
whether these records are committed or local-only — the answer changes whether
recovery survives a fresh clone, and is worth stating explicitly in the PR body
either way.
<!-- SECTION:NOTES:END -->
