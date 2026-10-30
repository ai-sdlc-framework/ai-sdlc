---
id: AISDLC-1118
title: doctor diagnoses the VS Code hierarchy-terminals setup (extension missing, stale after reinstall, nested workspace double-activation) and the docs give VS Code users one setup path
status: In Progress
assignee: []
created_date: '2026-10-29'
labels:
  - hierarchy
  - doctor
  - docs
  - usability
priority: medium
references:
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor.ts
  - ai-sdlc-plugin/commands/doctor.md
  - vscode-hierarchy/src/extension.ts
  - vscode-hierarchy/package.json
  - pipeline-cli/src/hierarchy/up.ts
  - docs/operations/cli-hierarchy.md
  - docs/operations/doctor.md
  - ai-sdlc-plugin/commands/hierarchy.md
---

## Description

On 2026-10-29 the operator ran the hierarchy from a VS Code window and saw no executor terminals while three dynamic executors were busy (`cli-hierarchy status` listed them; `tmux ls` held their sessions). The `vscode-hierarchy` extension (AISDLC-755) is the only thing that opens an integrated terminal per roster session, and it was installed, but it had been reinstalled from the vsix at 16:39Z during the plugin update while both open windows had activated the previous build at 16:37Z. A reinstalled extension does not take effect until the window reloads. A second confounder: the extension was active in two windows (the repo folder and its parent `dev/ai-sdlc`, both matching the `{.ai-sdlc,*/.ai-sdlc}/dispatch/hierarchy.json` pattern), so terminals can open in the window the operator is not looking at. Running `Developer: Reload Window` fixed it at once. Nothing in `doctor`, `cli-hierarchy up` or the docs told the operator any of this: `doctor` has `hierarchy-module` and `hierarchy-launch-env` checks but none for VS Code, `up` only skips its run-task hint when the extension sets `AI_SDLC_VSCODE_HIERARCHY=1`, and the install instructions are two bold paragraphs inside the `up` section of `docs/operations/cli-hierarchy.md` plus `ai-sdlc-plugin/commands/hierarchy.md`, with no "verify it works" step.

**Five-step review (requirements first).** Requirement questioned: should the CLI open OS terminal windows itself (osascript, Terminal.app, iTerm) so no extension is needed? No: the extension already does this for VS Code, the tasks file covers the non-extension path, and per-terminal-app code is a maintenance surface with no user asking for it. Deletion: nothing to delete; the `up` run-task hint stays. Simplified: one doctor check (`vscode-hierarchy-terminals`) that answers the three questions a VS Code user needs (installed? current? reaching this window?) with one remediation line each, instead of prose spread over two docs. Accelerated: the user learns in one `doctor` run what took a log dive to find. Automated: the check runs with the rest of `doctor`; the stale-build case becomes a mechanical `--fix` where it can be (reinstall the vsix) and a one-line instruction where it cannot (window reload is a VS Code action).

## Fix

1. `doctor-checks.ts`: add `checkVscodeHierarchyTerminals(ctx)` registered as `vscode-hierarchy-terminals`. Skip quietly (`[]`) when `TERM_PROGRAM !== 'vscode'` and `AI_SDLC_VSCODE_HIERARCHY` is unset (not a VS Code user). Otherwise:
   - **not installed** (`~/.vscode/extensions/ai-sdlc.vscode-hierarchy-*` absent and `code --list-extensions` lacks it or `code` is not on PATH): `warn`, remediation = the `pnpm --filter vscode-hierarchy package && code --install-extension vscode-hierarchy/dist/ai-sdlc-vscode-hierarchy.vsix` pair, with the `code` CLI setup line when `code` is missing.
   - **installed but not active in this window** (`AI_SDLC_VSCODE_HIERARCHY` unset while `TERM_PROGRAM === 'vscode'`): `warn`, remediation = `Developer: Reload Window` and the note that a reinstalled extension loads only on reload.
   - **stale**: the installed extension's `package.json` version or dist mtime is older than `vscode-hierarchy/dist/ai-sdlc-vscode-hierarchy.vsix` (when that file exists in the repo): `warn`, remediation = reinstall + reload. Make this the `fix:` entry (`fixVscodeHierarchyExtension`: run `code --install-extension`), and have the fix detail end with "reload the VS Code window to load it".
   - **nested workspaces**: when the roster file is reachable from more than one `.vscode` workspace (the repo folder and a parent folder both open, detected by `code --status` if available, else by `~/Library/Application Support/Code/User/workspaceStorage/*/workspace.json` entries whose `folder` is this repo or an ancestor containing it one level up): `warn`, remediation = close the parent-folder window or set `aiSdlc.hierarchy.enabled` (new setting, default true) to false in that window's workspace settings. Add the setting to `vscode-hierarchy/package.json` `contributes.configuration` and honour it in `extension.ts` (do not create a reconciler when false).
   - `pass` with title "vscode-hierarchy extension installed, current and active in this window" otherwise.
2. `extension.ts`: on activation, write the extension version into the terminal-creation hint and log it, so a stale build is visible in the Output channel; nothing else changes.
3. `pipeline-cli/src/hierarchy/up.ts`: when `TERM_PROGRAM === 'vscode'` and `AI_SDLC_VSCODE_HIERARCHY` is unset, the existing hint adds one line: "run `/ai-sdlc doctor` for the VS Code terminal setup".
4. Docs: give VS Code users one setup path.
   - `docs/operations/cli-hierarchy.md`: move the two bold paragraphs (AISDLC-754, AISDLC-755) out of `### up` into a new `## VS Code users` section with three steps: install the extension (commands), verify (`/ai-sdlc doctor` shows `vscode-hierarchy-terminals: pass`; or `up`, and one terminal per roster row appears), and "after a plugin update, reload the window". A short troubleshooting table: no terminals at all / terminals stop appearing after an update / terminals open in another window, each with the doctor finding and the remediation.
   - `ai-sdlc-plugin/commands/hierarchy.md`: the `## VS Code terminals` and `## VS Code extension` sections point at that section and keep only the commands.
   - `docs/operations/doctor.md`: add the new check to the check list with its four findings.
   - `ai-sdlc-plugin/commands/doctor.md`: add the check id to the list the command prints.
5. Tests: Vitest for the check with a fake `ctx.adapters` fs/exec covering each of the five outcomes and the skip; Vitest for the `--fix` entry; `vscode-hierarchy/src/reconciler.test.ts` or a new `extension` unit test for the `enabled=false` path; docs link check passes.

## Acceptance Criteria

- [ ] `/ai-sdlc doctor` in a VS Code terminal with the extension missing prints a `warn` whose remediation contains `code --install-extension`.
- [ ] After reinstalling the vsix without reloading, `doctor` prints the "not active in this window, reload" warning; after `Developer: Reload Window` it prints `pass`.
- [ ] With the repo and its parent folder both open in VS Code, `doctor` prints the nested-workspace warning naming both folders; setting `aiSdlc.hierarchy.enabled: false` in the parent window silences it and that window opens no terminals.
- [ ] `doctor --fix` reinstalls a stale vsix and its detail tells the user to reload the window; it never tries to reload itself.
- [ ] Outside VS Code (`TERM_PROGRAM` unset) the check emits nothing.
- [ ] `docs/operations/cli-hierarchy.md` has a `## VS Code users` section with install, verify and after-update steps and the troubleshooting table; `hierarchy.md` and `doctor.md` reference it; no duplicate install prose remains.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; patch coverage at or above the 90% gate.

## Out of scope

- Opening OS terminal windows (Terminal.app, iTerm) from the CLI.
- Reloading the VS Code window automatically from the CLI or the extension.
- Publishing the extension to the marketplace or auto-installing it from the plugin install.
- JetBrains or other editors.
