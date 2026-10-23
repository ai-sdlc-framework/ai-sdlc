---
id: AISDLC-1048
title: 'LAST_MESSAGE.md saves the final reply, stamped final or interim, never a mid-turn progress line'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - hierarchy
  - plugin
  - hooks
dependencies: []
references:
  - ai-sdlc-plugin/hooks/context-auto-clear.js
  - ai-sdlc-plugin/hooks/context-auto-clear.test.mjs
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
priority: high
dispatchable: true
---

## Description

The Stop hook `context-auto-clear.js` persists the session's last reply to `.claude/memory/LAST_MESSAGE.md` (AISDLC-914) so a clear never hides it. On 2026-10-22 the ai-sdlc-io planner session filed an upstream Claude Code feature request (issue 104409 in the claude-code repository) at 22:34:17Z and ended its turn at 22:34:44Z with the reply "The feature request is filed" with the issue number. LAST_MESSAGE.md recorded instead the line written three minutes earlier, mid-turn, before six tool calls: "Several near-duplicates surfaced. Reading them before deciding whether to file new or join an existing thread." The next planner session resumed from that line, treated the filing as not done, and filed a second, unwanted public issue (104458 in the same repository, since closed).

Cause, in `lastAssistantText`: the loop walks the transcript backwards and skips every entry that carries no text block, including tool-only assistant entries and tool results (`if (parts.length) break; continue;` only breaks once text was found). When the Stop hook reads the JSONL before the final text line is flushed (the hook ran in the same second as that reply), the walk continues back to the most recent text anywhere in the turn, which is a progress line, and saves it as if it were the reply.

Fix:

1. Collect text only from the trailing run of assistant entries that comes after the last tool result. If that run has no text, do not fall back to earlier text: write `(turn ended on a tool call; no final reply recorded, see the handoff file)`.
2. Beat the flush race: when the trailing entry is an assistant tool call or the transcript ends on a tool result, re-read the file once after a short delay (bounded, under one second) before deciding.
3. Stamp the saved section with the entry timestamp of the text and a marker, `final` when the text is the last entry in the transcript, `interim` otherwise, so a reader can see when the line predates later actions. Prefer the Stop payload's own last-message field when Claude Code supplies one (check the current hook input schema; SubagentStop has `last_assistant_message`, confirm for Stop).
4. In `planner.md` and `operator-dispatch.md`, state that LAST_MESSAGE.md is shown to the operator and nothing more: it never outranks the handoff RESUME block, and outward state (issues, PRs, comments) is verified at the source before it is proposed as remaining work.

**Five-step review (requirements first).** Requirement questioned: does a cleared session need the last reply at all, when the handoff file already carries the state? It does: the handoff is board-derived and the operator reads the reply to learn what was said, so the file stays, but as a display aid with an explicit rank below the handoff. Deletion: the fallback walk to earlier text is deleted; a wrong line is worse than no line. Simplified: one rule, text from the trailing assistant run after the last tool result, instead of a heuristic over the whole transcript. Accelerated: one bounded re-read beats the flush race without a watcher. Automated last: a unit test with the real transcript shape (text, tool calls, final text not yet flushed) guards the regression.

## Acceptance Criteria

- [ ] `lastAssistantText` (or its replacement) returns the final reply for a transcript of the shape: interim text, six tool-call and tool-result pairs, final text. It returns the no-reply marker, never the interim text, when the final text line is absent.
- [ ] The saved section carries the text's entry timestamp and a `final` or `interim` marker.
- [ ] A test reproduces the 2026-10-22 shape (unflushed final line) and passes.
- [ ] `planner.md` and `operator-dispatch.md` rank LAST_MESSAGE.md below the handoff RESUME block and require source verification of outward state before proposing it as work.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
