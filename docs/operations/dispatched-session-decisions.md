# Dispatched-Session Decisions — Operator Runbook

**Context:** AISDLC-480 — Decision Catalog routing for developer subagent escalations and non-interactive AskUserQuestion.

## Background

When a developer subagent runs in a dispatched (non-interactive) session — a background `Agent` call, a tmux pane, or a `claude -p` worker — it cannot prompt the operator interactively. Prior to AISDLC-480, a blocking decision point had two bad failure modes:

1. **Dead-letter**: the subagent returned `prUrl: null` with a `notes` string that disappeared into a PR comment, invisible to `cli-decisions list`.
2. **Hang**: a session that called AskUserQuestion in a non-TTY context would block indefinitely.

AISDLC-480 wires the Decision Catalog (`cli-decisions escalate`) as the async escape hatch for both cases.

## How dispatched-session decisions appear

### Case A — developer subagent escalation (blocked OQ / scope choice)

When a developer subagent hits a blocking open question or scope-creep decision, it:

1. Calls `cli-decisions escalate` with `--task-id`, `--source-worktree`, `--summary`, and `--option` entries.
2. Returns `prUrl: null` with the catalog decision-id in `notes`.

The escalation record is immediately visible:

```bash
# List all pending decisions (escalations show up here):
node pipeline-cli/bin/cli-decisions.mjs list

# Show full context for a specific decision:
node pipeline-cli/bin/cli-decisions.mjs show DEC-NNNN
```

The `show` output includes:
- `taskId` and `sourceWorktree` in the body (for resume context, AC-4)
- The options the subagent surfaced
- The `by` field identifies the dispatched session: `dispatched-session:AISDLC-NNN`

### Case B — non-interactive AskUserQuestion routing

When a dispatched session encounters a question it cannot answer autonomously:

```bash
node pipeline-cli/bin/cli-decisions.mjs escalate \
  --task-id "AISDLC-NNN" \
  --source-worktree "$(pwd)" \
  --summary "Which storage backend to use?" \
  --option "opt-json:Use JSON file storage — simple, no dep" \
  --option "opt-sqlite:Use SQLite — better perf for large catalogs" \
  --body "Context: task requires persistent state; see AISDLC-NNN §Implementation Notes." \
  --exit-code 1
```

The `--exit-code 1` flag causes the command to:
1. Write the Decision Catalog record.
2. Print the `decisionId` on stdout (JSON format if `--format json`, text otherwise).
3. Exit with code 1.

The calling script detects the non-zero exit and logs the decision-id. The developer subagent returns `prUrl: null` with the decision-id in `notes`.

## How the operator answers a decision

```bash
# See what decisions need operator input:
node pipeline-cli/bin/cli-decisions.mjs list

# Read full context for a specific decision:
node pipeline-cli/bin/cli-decisions.mjs show DEC-NNNN

# Pick an option and record the answer:
node pipeline-cli/bin/cli-decisions.mjs answer DEC-NNNN opt-json \
  --by "dominique@reliablegenius.io" \
  --rationale "JSON is sufficient for the current scale; SQLite adds complexity"
```

## How to resume a task after answering the decision

The decision record carries `taskId` and `sourceWorktree` in its body. After answering:

1. Navigate to the worktree: `cd <sourceWorktree>`.
2. Re-dispatch the developer subagent for the same task, passing the chosen option in the task body or as an implementation note.

Example:
```bash
cd /path/to/.worktrees/aisdlc-nnn
# The worktree is preserved on disk — re-dispatch:
# /ai-sdlc execute AISDLC-NNN
```

Or, if the task was partially implemented before the escalation, the worktree may have commits already. Check:
```bash
git log --oneline -5
```

If commits exist: the developer subagent's earlier work is preserved. Re-dispatching will resume from where it left off, with the decision now answered.

## Feature flag gate

All `cli-decisions escalate` calls are gated on `AI_SDLC_DECISION_CATALOG` (default-ON since AISDLC-392).

When the flag is **off** (`AI_SDLC_DECISION_CATALOG=off`):
- `cli-decisions escalate` prints a warning on stderr and does NOT write a catalog record.
- It still exits with the `--exit-code` value so callers that rely on non-zero for clean-fail detection continue to work.

To opt out: `export AI_SDLC_DECISION_CATALOG=off`.

To confirm the current state:
```bash
node pipeline-cli/bin/cli-decisions.mjs list --format json | jq '.enabled'
```

## Decision schema (AC-4 — resume context fields)

Each escalation record carries:

| Field | Value | Notes |
|---|---|---|
| `metadata.id` | `DEC-NNNN` | Stable decision id (never changes) |
| `metadata.source` | `subagent-escalation` | Identifies dispatched-session origin |
| `spec.summary` | One-line question | What the subagent needs to know |
| `spec.body` | `taskId: AISDLC-NNN\nsourceWorktree: /path` | Resume context, prepended automatically |
| `spec.options` | Array of `{id, description}` | Options the subagent surfaced |
| `spec.contextRef` | Task id (e.g. `AISDLC-480`) | Backlink for audit trail |
| `metadata.scope` | `task:AISDLC-NNN` (default) | Override via `--scope` |
| `decisionLog[0].by` | `dispatched-session:AISDLC-NNN` | Machine-parseable session id |

## Mechanism-agnostic contract (AC-3)

`cli-decisions escalate` is a thin CLI wrapper over the same `makeDecisionOpenedEvent` + `appendDecisionEvent` primitives that the interactive `cli-decisions add` uses. It works identically regardless of the dispatch mechanism:

- **Native background-Agent dispatch** (Pattern X v2, `/ai-sdlc orchestrator-tick`): the developer subagent calls the CLI directly from within its worktree.
- **tmux execute-parallel**: each pane session calls the CLI; all writes go to the same `.ai-sdlc/_decisions/events.jsonl` log (append-only, no lock needed for single-writer per call).
- **`claude -p` workers** (Pattern Y / claude-p-shell): workers call the CLI via shell; the event log path is resolved from `--work-dir` (defaults to `cwd` which is the worktree).

## Related runbooks

- `docs/operations/decision-catalog-promotion.md` — general Decision Catalog lifecycle
- `docs/operations/decision-catalog-phase10-adopter-integration.md` — adopter integration guide
- RFC-0035 — Decision Catalog specification
