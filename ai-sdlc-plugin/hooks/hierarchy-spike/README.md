# hierarchy-spike (RFC-0058 phase 0, AISDLC-1033)

Throwaway spike, removed by phase 1. It is a standalone
mod folder and is not listed in the plugin's own hooks, so no adopter loads it.

Run: `claude --plugin-dir ai-sdlc-plugin/hooks/hierarchy-spike`, then from a
second session `$.session.send` to the first by roster name with `hier:consume`, `hier:run clear`,
`hier:run compact`, `hier:dump` (submits the log as a prompt), or any other text (model-relayed baseline). Results append to the
`hierarchy-spike/log` list in `$.store` (a hooks module cannot import node:fs); `hier:dump` emits it,
save it to `.ai-sdlc/hierarchy-spike.log` after the run. Validate with `claude plugin validate` and `claude plugin test`.
