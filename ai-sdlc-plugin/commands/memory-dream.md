---
name: memory-dream
description: Consolidate, prune and refine the agent memory folder into a new reviewable folder (run, apply, undo). Never modifies the live folder until apply.
argument-hint: "run [--dry-run] [--instructions \"<text>\"] | apply <output-folder> | undo"
allowed-tools: Bash, Read
model: haiku
---

Run a memory dream (AISDLC-729): a synthesis pass over the memory folder that merges duplicates, replaces superseded notes with the latest value, moves finished work into an on-disk archive, condenses large notes and rewrites index lines. It is modelled on a managed-agents "dream": the input is never modified, and you review the output before swapping it in. Nothing here refuses or blocks anything.

Memory notes are private. Never paste note content into chat, PR text or logs; report only the counts and paths the CLI prints.

## Run

Resolve the pipeline CLI, then pass `$ARGUMENTS` straight through. With no arguments, do a dry run first.

```bash
PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}}/scripts"
if [ -z "${PIPELINE_CLI_BIN:-}" ]; then
  if [ -f "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh" ]; then
    PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || { echo "ERROR: @ai-sdlc/pipeline-cli not found; export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin" >&2; exit 1; }
  else
    PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
  fi
fi
if [ -z "$ARGUMENTS" ]; then ARGUMENTS="run --dry-run"; fi
eval "node \"$PIPELINE_CLI_BIN/cli-memory-dream.mjs\" $ARGUMENTS"
```

## Subcommands

- `run` resolves the folder (the `autoMemoryDirectory` setting, else the harness default), runs the mechanical pass, then the model pass (`sonnet` by default), and writes a new folder beside the input plus a report. `--dry-run` runs only the mechanical pass and prints what the model pass would read. Optional: `--instructions "<text>"`, `--index-max-lines`, `--index-max-bytes`, `--note-max-bytes`, `--allow-low-confidence`, `--mine-transcripts` (proposals only) with `--add-proposals` (explicit).
- `apply <output-folder>` swaps the reviewed output in, keeps the last three previous versions, and carries over notes added or changed since the run started.
- `undo` restores the most recent previous version.

## After a run

Tell the user the output folder, the report path and the summary numbers, and that the output is unapplied. Do not apply it unless the user asks. If the CLI prints a `suggestion:` line, relay it. See `docs/operations/memory-dream.md`.
