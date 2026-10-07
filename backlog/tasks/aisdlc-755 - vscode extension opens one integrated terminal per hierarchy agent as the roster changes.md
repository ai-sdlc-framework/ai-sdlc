---
id: AISDLC-755
title: >-
  VS Code extension opens one integrated terminal per hierarchy agent as the roster changes
status: To Do
assignee: []
created_date: '2026-10-07'
labels:
  - rfc-0051
  - dispatch
  - developer-experience
dependencies:
  - AISDLC-754
references:
  - pipeline-cli/src/hierarchy/terminals.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/types.ts
  - spec/schemas/hierarchy-roster.v1.schema.json
  - docs/operations/cli-hierarchy.md
  - ai-sdlc-plugin/commands/hierarchy.md
  - pnpm-workspace.yaml
  - release-please-config.json
priority: medium
dispatchable: true
blocked:
  reason: "Gate 7 CI path (dor-evaluate --body-file) ignores frontmatter dependencies and flags the declared AISDLC-754 sequencing sentence; override until AISDLC-758 lands"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The operator asked on 2026-10-07: when the hierarchy starts an agent and VS Code is running, open a terminal for it automatically. VS Code exposes no command-line entry point that opens an integrated terminal (`code` cannot run editor commands, and `tasks.json` auto-runs only on folder open), so the CLI cannot do this alone. The sanctioned way is a small extension that watches the roster and opens terminals itself. AISDLC-754 makes the generated tasks file correct and gives `up` a VS Code hint; this task removes the keystroke.

Add a VS Code extension as a new private workspace package `vscode-hierarchy/` (name `@ai-sdlc/vscode-hierarchy`, `"private": true`, added to `pnpm-workspace.yaml`; not tracked by release-please until a publishing decision is recorded, so do not add it to `release-please-config.json` in this task). Behaviour:

- On activation (workspace contains `.ai-sdlc/dispatch/hierarchy.json`, found in the opened folder or one level below it so the operator's parent-folder layout works), read the roster, then watch the file with the VS Code file-system watcher.
- For every roster session with a live `tmuxWindow` that has no terminal yet, create an integrated terminal named after the agent that runs `node <abs cli-hierarchy.mjs> attach <name>`, resolving the bin the same way AISDLC-754's generator does (prefer `pipeline-cli/bin/cli-hierarchy.mjs` under the repo, else the plugin cache path recorded in the roster or the `PIPELINE_CLI_BIN` setting). Terminals are created with `isTransient: true` so they are not restored on reload and re-created from the roster instead.
- When a session leaves the roster (`down`, or a `down --role`), dispose its terminal. When the roster file is deleted, dispose all of them.
- Never open a terminal twice for the same agent: keep a map from agent name to terminal and reconcile on every change event and on `onDidCloseTerminal`.
- Settings (`aiSdlc.hierarchy.*`): `autoOpen` (default `true`), `focusNew` (default `false`), `pipelineCliBin` (optional path override). Commands: `AI-SDLC: Open all hierarchy agents`, `AI-SDLC: Close all hierarchy agents`.
- Packaging: `vsce package` into `vscode-hierarchy/dist/*.vsix` via a `package` script; `.vscode/extensions.json` in this repo recommends the extension id. Document installation (`code --install-extension <vsix>`) in `docs/operations/cli-hierarchy.md` and the `/ai-sdlc hierarchy` recipes; `cli-hierarchy up` running inside VS Code without the extension active keeps printing the AISDLC-754 hint, and prints nothing extra when the extension is present (the extension sets `AI_SDLC_VSCODE_HIERARCHY=1` in `terminal.integrated.env` so the CLI can tell).
- Tests: unit tests for the reconciler (roster diff to open/dispose actions) with a fake terminal API under Vitest, no VS Code runtime needed; the extension entry stays a thin adapter. The reconciler module must be imported by the extension entry so the dark-code gate sees it wired.

Sequencing: dispatch after AISDLC-754 merges, which defines the generated-file marker and the bin-resolution rule this extension reuses.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] With the extension installed and VS Code open on the repo (or its parent folder), `cli-hierarchy up --executors 2` results in four integrated terminals (planner, operator-dispatch, executor-alpha, executor-beta), each attached to its tmux session, without any operator action.
- [ ] `cli-hierarchy up --executors 5` afterwards opens exactly three more terminals (gamma, delta, epsilon); no agent ever gets a second terminal.
- [ ] `cli-hierarchy down --role executor-epsilon` disposes that one terminal; `cli-hierarchy down --confirmed` disposes them all.
- [ ] `aiSdlc.hierarchy.autoOpen: false` stops automatic opening while the "Open all hierarchy agents" command still works.
- [ ] Reconciler unit tests cover: initial open, incremental add, removal, roster deletion, terminal closed by the user then roster unchanged (no reopen until the next roster write), and bin resolution order.
- [ ] `vscode-hierarchy` is a private workspace package, `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass, and `pnpm lint:publishable` still passes.
- [ ] `docs/operations/cli-hierarchy.md` and `ai-sdlc-plugin/commands/hierarchy.md` document installation and settings.
