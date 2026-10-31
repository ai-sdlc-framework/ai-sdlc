---
name: operator-tui-retired-web-ui-preferred
description: Operator 2026-10-13: the operator TUI (RFC-0023, pnpm tui) is a finished experiment with many broken features; a web dashboard is the preferred direction for agent/pipeline status
metadata:
  type: project
---

Operator ran `pnpm tui` on 2026-10-13 (after fixing the nvm default to 22.23.2): "some things are working but a lot of the features are broken. It was a nice experiment but I don't think it will be used that much. TUI as an interface for what is effectively a dashboard doesn't really have much in the way of components to visually display data very well. A better interface would be a web UI/UX."

**Why:** the TUI (RFC-0023, `pipeline-cli/src/tui`, flag `AI_SDLC_TUI`) cannot render the dashboard-style data (PR flow, agent roster, throughput) well, and its promotion corpus never reached the bar.

**How to apply:**
- Do not invest further in the TUI (no fixes for its broken panels, no promotion of `AI_SDLC_TUI`). Post-drain: propose an RFC for a web dashboard (agent roster + board + PR flow + decisions), and a task to retire or archive the TUI and its promotion doc. Both wait for the operator's go after the PR drain (DEC-0127).
- For live agent status today use `cli-hierarchy status` and `cli-hierarchy attach <name>`.
- Related: [[planner-is-exception-handler]].
