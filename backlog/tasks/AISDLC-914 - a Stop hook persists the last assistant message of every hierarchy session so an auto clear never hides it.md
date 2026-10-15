---
id: AISDLC-914
title: 'feat: a Stop hook persists the last assistant message of every hierarchy session to .claude/memory/LAST_MESSAGE.md so an auto clear never hides it'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [feature, plugin, hierarchy]
dependencies: []
references: [ai-sdlc-plugin/hooks/context-auto-clear.js, ai-sdlc-plugin/hooks/context-auto-clear.sh, ai-sdlc-plugin/hooks/context-auto-clear.test.mjs, ai-sdlc-plugin/plugin.json, ai-sdlc-plugin/commands/planner.md, docs/operations/cli-hierarchy.md]
priority: high
dispatchable: true
---

## Description

Operator report 2026-10-14: "when an auto clear happens I can't read what the last message was." The Stop hook `context-auto-clear` (AISDLC-766) schedules `/clear` when a hierarchy session's context passes its role threshold. The clear wipes the terminal scrollback with the context, so the ruling or digest the session had just printed is gone before the operator reads it. The handoff file (`cli-hierarchy handoff write`) records board and catalog state, not the prose of the final reply. The planner session worked around it by hand this session, appending its final message to `.claude/memory/LAST_MESSAGE.md` each turn.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the operator must read the reply before the clear fires. Nothing requires that; the reply only needs to survive the clear. 2. Deleted: the hand rule that every planner and dispatch session copies its final reply into `LAST_MESSAGE.md` (memory `feedback_last_message_survives_auto_clear`), replaced by the hook. 3. Simplified: the existing Stop hook already receives `transcript_path` and already knows whether the session is in a roster. Add one step before the threshold check: read the last `assistant` entry of the transcript, take its text blocks, and write them under a `## <roster name> — <ISO time>` heading into `<project>/.claude/memory/LAST_MESSAGE.md`, keeping the last entry per session name (overwrite that section, do not grow the file). Sessions outside a roster are untouched; every error path exits 0 and never delays the Stop. 4. Accelerated: the operator reads the file, or the SessionStart reload prints it; no scrolling, no asking the session to repeat itself. 5. Automated: the planner and dispatch command prose that reloads the handoff after a clear also prints the session's own `LAST_MESSAGE.md` section in the first reply.

## Acceptance Criteria

- [ ] After a Stop in a roster session, `.claude/memory/LAST_MESSAGE.md` holds that session's last assistant text under a heading with its roster name and time; a second Stop replaces that section and leaves other sessions' sections intact.
- [ ] Tool-use blocks, thinking blocks and tool results are excluded; only text blocks of the last assistant turn are written.
- [ ] A session with no roster, no transcript, or an unreadable transcript writes nothing and the hook exits 0; `AI_SDLC_LAST_MESSAGE=off` switches it off.
- [ ] `ai-sdlc-plugin/hooks/context-auto-clear.test.mjs` covers the write, the per-session replacement, the exclusion of non-text blocks, and the off switch.
- [ ] `ai-sdlc-plugin/commands/planner.md` and `operator-dispatch.md` tell the session to print its own section of `LAST_MESSAGE.md` right after a clear; `docs/operations/cli-hierarchy.md` documents the file.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

`.claude/memory/` is the per-project auto-memory folder and is already where the handoff is written, so no new location is introduced. The file is a convenience for the operator, not a source of authority: nothing reads it to make a decision.
