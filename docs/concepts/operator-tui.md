---
title: "Operator TUI (retired)"
description: "The operator terminal UI is retired; no further investment, a web dashboard RFC follows."
---

The operator TUI (RFC-0023) is retired by operator decision on 2026-10-13: no further investment, and a web dashboard RFC follows. The decision is recorded in the completed task [AISDLC-891](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/backlog/completed/AISDLC-891%20-%20delete%20the%20completed%20promotion%20runbooks%20and%20the%20retired%20orchestrator%20conductor%20and%20tui%20runbooks%20from%20docs%20operations.md).

- `pipeline-cli/bin/cli-tui.mjs` still ships, but the TUI is retired: it runs only with `AI_SDLC_TUI` set and is unsupported.
- For pipeline status and open decisions use `cli-status` and `cli-decisions`, or the [session hierarchy](./session-hierarchy.md) planner session.
- Original design: [RFC-0023](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md).
