# hierarchy-spike (RFC-0058 phase 0, AISDLC-1033)

Throwaway spike, removed by phase 1. It is a standalone
mod folder and is not listed in the plugin's own hooks, so no adopter loads it.

Run: `claude --plugin-dir ai-sdlc-plugin/hooks/hierarchy-spike`, then from a
second session `$.session.send` to the first by roster name with `hier:consume`, `hier:run clear`,
`hier:run compact`, `hier:dump` (submits the log as a prompt), or any other text (model-relayed baseline). Results append to the
`hierarchy-spike/log` list in `$.store` (a hooks module cannot import node:fs); `hier:dump` emits it,
save it to `.ai-sdlc/hierarchy-spike.log` after the run. Validate with `claude plugin validate` and `claude plugin test`.

Protocol notes (rerun, AISDLC-1050):

- `session.receive` delivers the whole `<cross-session-message>` envelope; the mod matches on the inner text.
- The receiver drops a third byte-identical peer message from one sender, so number the texts: `hier:consume 1` to `hier:consume 5`, and five distinct baseline texts.
- The command is namespaced: the mod submits `/hierarchy-spike:hier-ping`.
- `$.store` persists under `~/.claude/plugins/store/`; recover the log there if `hier:dump` never reaches the hook.
- Order: five consumes, five baseline messages, `hier:run clear`, `hier:run compact`, `hier:dump`.
- Subagent sends arrive with a backslash-escaped inner wrapper (`<\agent-message ...>`); headless `claude -p` sends carry none. The mod strips both.
- `session.receive` must return `{ consumed: <string> }` (not `true`) or the host skips the hook and the model takes a turn.
- Open point for phase 1: after the mod-run clear no post-clear `session.start` hook fired, so the `/hierarchy-spike:hier-ping` follow-up submission is unverified.
