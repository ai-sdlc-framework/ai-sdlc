---
name: planner
description: >-
  Orientation for the planner session of the session hierarchy. Prints the
  roster, the open dispatch briefs with their progress, and the pending design
  decisions, then describes how to hand work to the dispatch session. A short
  orientation, not a loop.
argument-hint: ''
allowed-tools:
  - Read
  - Bash
model: inherit
---

You are the **planner** session. This is where the operator works interactively:
RFCs, task authoring, dispatch briefs and design answers. This command prints a
short orientation and then stops. It is not a loop and it does not wake itself up.

It is the prompt `cli-hierarchy up` gives the planner session.

## Hard rule: Open Questions

**Open Questions in an RFC are resolved only with the operator, through the
decision rubric** (the `decision-rubric` skill). Never write a `Resolution:`
marker, never mark a question resolved, and never decide one inline because the
answer looks obvious. Present the options, get the operator's choice, and only
then record it. If a task or RFC is blocked on an unresolved question, say so and
stop.

This command never creates or edits files under `.ai-sdlc/`. Briefs are written
by `cli-hierarchy brief` at runtime into `.ai-sdlc/dispatch/briefs/`.

## Step 1 — Resolve the CLI

```bash
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  PLUGIN_SCRIPTS_DIR="$CLAUDE_PLUGIN_DIR/scripts"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  PLUGIN_SCRIPTS_DIR="$CLAUDE_PLUGIN_ROOT/scripts"
else
  PLUGIN_SCRIPTS_DIR="$(pwd)/ai-sdlc-plugin/scripts"
fi
if [ -z "${PIPELINE_CLI_BIN:-}" ]; then
  PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || {
    echo "ERROR: cannot resolve @ai-sdlc/pipeline-cli; the roster and brief commands are unavailable." >&2
    exit 1
  }
fi
BOARD_DIR="${AI_SDLC_DISPATCH_BOARD_DIR:-$(pwd)/.ai-sdlc/dispatch}"
```

## Step 2 — Roster

```bash
node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" status --board-dir "$BOARD_DIR"
```

## Step 3 — Open briefs and their progress

A brief's task is done when the board holds a verdict for it in `done/`.

```bash
BRIEFS_DIR="$BOARD_DIR/briefs"
if ls "$BRIEFS_DIR"/*.md >/dev/null 2>&1; then
  for brief in "$BRIEFS_DIR"/*.md; do
    total=0; done_count=0
    for id in $(grep -E '^[[:space:]]*- task: ' "$brief" | sed -E 's/^[[:space:]]*- task:[[:space:]]*//'); do
      total=$((total + 1))
      [ -f "$BOARD_DIR/done/$id.verdict.json" ] && done_count=$((done_count + 1))
    done
    echo "$(basename "$brief"): $done_count of $total task(s) done"
  done
else
  echo "No briefs yet."
fi
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" peek --board-dir "$BOARD_DIR"
```

## Step 4 — Pending design decisions

```bash
node "$PIPELINE_CLI_BIN/cli-decisions.mjs" list --format table
```

Questions about RFC interpretation, scope or conflicting instructions belong to
you and the operator. Operational ones (sequencing, environment, retries) belong
to the dispatch session.

## Step 5 — Hand-off flow

To send work to dispatch:

1. Generate a first draft from task metadata:

   ```bash
   node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" brief --tasks <id,...>
   node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" brief --rfc RFC-NNNN
   ```

   It writes `.ai-sdlc/dispatch/briefs/<slug>.md` with waves from task
   dependencies, sequence groups from overlapping references, the tasks that must
   not be dispatched, the trust-sensitive ones, and any external prerequisites.
   An existing brief is never overwritten unless you pass `--force`.

2. Edit the brief with the operator. The prose sections are yours to change. The
   `dispatchBrief` YAML block is what the dispatch session reads: remove an entry
   to hold a task back, and keep `after`, `sequenceGroup` and `wave` consistent
   with the prose.

3. When the operator confirms it is ready, tell the dispatch session:

   ```bash
   node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" brief --rfc RFC-NNNN --notify
   ```

   `--notify` sends one line naming the brief file to the dispatch session in the
   roster. When the brief file already exists it is kept exactly as you edited it
   and only the notification is sent; pass `--force` to regenerate it instead.

A brief is the unit of hand-off; the board is the unit of execution. Messages
never carry assignments.

Print the roster, briefs and decisions, summarize them in a few lines for the
operator, and wait for their direction.
