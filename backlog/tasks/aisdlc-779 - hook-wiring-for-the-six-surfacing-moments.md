---
id: AISDLC-779
title: >-
  hook wiring for the six surfacing moments
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-3
dependencies:
  - AISDLC-775
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/subagent-start.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire the RFC-0053 surfacing protocol into the plugin hooks. Register `UserPromptSubmit`, `PreToolUse` and `PostToolUse` (tool touch), `SubagentStart` (task claim), `SessionStart` and `PreCompact` for the context engine. The plugin today registers SessionStart, SubagentStart, PreToolUse, PostToolUse and Stop. Each hook extracts a key (message text, file path or command, task body, compaction summary), calls `cli-context query --session <id> --budget N --min-score S`, and injects the slice as data with citations, never as instructions. The decision-point moment is delivered by the DoR gate task and is out of scope here.

Sequencing: listed in `dependencies:` (AISDLC-775).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `plugin.json` registers `UserPromptSubmit` and `PreCompact` and keeps the existing SessionStart, SubagentStart, PreToolUse, PostToolUse and Stop registrations (manifest test).
- [ ] Each hook calls `cli-context query` with `--session`, `--budget` and `--min-score` from the active profile (test with a stub CLI).
- [ ] Injected slices are wrapped as data with entry ids and citations and carry no imperative framing (test on the rendered output).
- [ ] A hook failure or a missing `cli-context` binary never blocks the tool call or the prompt (test: hook exits 0 with no injection).
- [ ] `PreCompact` re-runs the session-start retrieval against the compaction summary (test).
- [ ] Hooks inject nothing when the active profile disables the moment (test per moment).
