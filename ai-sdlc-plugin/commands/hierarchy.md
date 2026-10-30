---
name: hierarchy
description: Drive the session hierarchy (planner, dispatch, executors) from Claude Code by running `cli-hierarchy <subcommand>` from the resolved pipeline-cli bin. Pass-through for up, status, attach, terminals, brief, down.
argument-hint: '<up|status|attach|terminals|brief|down> [options]'
allowed-tools: Bash
model: haiku
rung: 3
bounds: "tightly scoped template prompt over structured inputs; fixed output; no free prose; no retries beyond the caller cap"
---

Run `cli-hierarchy $ARGUMENTS` (reference:
[`docs/operations/cli-hierarchy.md`](../../docs/operations/cli-hierarchy.md)) and
surface its output unchanged. All logic lives in
`ai-sdlc-plugin/scripts/hierarchy-dispatch.mjs`; this body only resolves the plugin
scripts directory and forwards the arguments.

## Usage

```
/ai-sdlc hierarchy
/ai-sdlc hierarchy status
/ai-sdlc hierarchy up --executors 1
/ai-sdlc hierarchy down
```

- `up`, `status`, `terminals`, `brief`, `down` run as given.
- `attach <name>` and `up --attach` cannot switch your terminal from inside Claude
  Code: the script prints the exact shell command to run instead.
- `clear`, `tick`, `restart`, `register`, `playbook`, `route-decision`, `check-repo`, `executor-start` are refused with a
  one-line explanation: they belong to the dispatch and executor loop bodies.
- No arguments prints `cli-hierarchy --help` followed by a common-recipes block.
- If the pipeline-cli bin cannot be found, the same install hint as
  `/ai-sdlc doctor` is printed.

## VS Code terminals

`up` keeps `.vscode/tasks.json` current (unless `--no-vscode-tasks`), as long as the file is
absent or carries the `ai-sdlc.generated` marker. To get one terminal per agent:

1. `/ai-sdlc hierarchy up --executors 5` (regenerates the tasks file).
2. In VS Code run Terminal > Run Task > `hierarchy: open all agents`.

A hand-written `tasks.json` is never overwritten; merge by hand from
`/ai-sdlc hierarchy terminals --vscode --print`.

## Implementation contract

Run from the repository root:

```bash
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  PLUGIN_SCRIPTS_DIR="$CLAUDE_PLUGIN_DIR/scripts"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  PLUGIN_SCRIPTS_DIR="$CLAUDE_PLUGIN_ROOT/scripts"
else
  PLUGIN_SCRIPTS_DIR="$(pwd)/ai-sdlc-plugin/scripts"
fi
cd "$(git rev-parse --show-toplevel)"
node "$PLUGIN_SCRIPTS_DIR/hierarchy-dispatch.mjs" $ARGUMENTS
```

## VS Code extension

The `vscode-hierarchy` extension opens one terminal per roster agent. Install, verify (`/ai-sdlc doctor`), after-update and troubleshooting steps are in the
"VS Code users" section of [`docs/operations/cli-hierarchy.md`](../../docs/operations/cli-hierarchy.md#vs-code-users).
