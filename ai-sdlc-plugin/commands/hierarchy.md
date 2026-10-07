---
name: hierarchy
description: Drive the session hierarchy (planner, dispatch, executors) from Claude Code by running `cli-hierarchy <subcommand>` from the resolved pipeline-cli bin. Pass-through for up, status, attach, terminals, brief, down.
argument-hint: '<up|status|attach|terminals|brief|down> [options]'
allowed-tools: Bash
model: inherit
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
/ai-sdlc hierarchy up --executors 1 --no-planner
/ai-sdlc hierarchy down
```

- `up`, `status`, `terminals`, `brief`, `down` run as given.
- `attach <name>` and `up --attach` cannot switch your terminal from inside Claude
  Code: the script prints the exact shell command to run instead.
- `clear`, `tick`, `route-decision`, `check-sender`, `check-repo` are refused with a
  one-line explanation: they belong to the dispatch and executor loop bodies.
- No arguments prints `cli-hierarchy --help` followed by a common-recipes block.
- If the pipeline-cli bin cannot be found, the same install hint as
  `/ai-sdlc doctor` is printed.

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

## Confirming `down`

`down` with no `--role` stops every session and returns inflight manifests to the
queue. The script exits 3 and prints a notice when it is run unconfirmed. When that
happens, ask the operator once whether to stop every session; only on a yes, run the
same command again with `--confirmed` appended:

```bash
node "$PLUGIN_SCRIPTS_DIR/hierarchy-dispatch.mjs" down --confirmed
```

`down --role <role>` needs no confirmation.
