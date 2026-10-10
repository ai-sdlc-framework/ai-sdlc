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

## Escalation chain (session hierarchy)

Under the session hierarchy a question goes to the lowest tier able to answer it, and an
unanswered question never stops throughput: the executor parks the task and claims the next one.

| Tier                                                           | Raised with                                                                   | Answered by                                              | Timebox (default) |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| `operational` (sequencing, environment, retries)               | `escalate --route operational`                                                | `operator-dispatch` or the planner                       | 30 minutes        |
| `design` (RFC interpretation, scope, conflicting instructions) | `escalate --route design` (also the stored route when only `--park` is given) | the planner                                              | 4 hours           |
| `operator`                                                     | reached only by promotion, or by the planner through the decision rubric      | the operator, from a terminal outside the session roster | none (terminal)   |

```bash
# Executor: raise it, park the task, then stop work on this task and claim the next one.
node pipeline-cli/bin/cli-decisions.mjs escalate --route operational --park \
  --task-id "AISDLC-NNN" --source-worktree "$(pwd)" \
  --summary "<one line: what is blocking>" \
  --option "opt-a:<first option>" --option "opt-b:<second option>"
```

- **Recorded on the decision** (only when `--route` or `--park` is given): the route, the raising session's roster name and the task id. A
  later move up the chain is a `routing-changed` event, so `show` carries every hop.
- **`--park`** refuses to park a manifest whose recorded claiming worker is a different roster
  session than the caller (when the manifest records no worker, the check is skipped). It moves the task's inflight manifest to `blocked/` with `blockedBy` set to the decision
  id, and the command exits non-zero (1 unless `--exit-code` asks for another non-zero value) so the
  executor knows to stop. If no inflight manifest exists the decision is still recorded, and a warning
  says nothing was parked.
- **Answering is scoped to the tier.** `answer` looks up the calling session's roster role and
  refuses an out-of-scope answer with the reason and the next step (for example, an `operator-dispatch`
  session answering a `design` decision is told to forward it to the planner). A caller with no roster
  session among its ancestors is the operator at a terminal and may answer at any tier; if the caller's
  identity cannot be resolved at all (unreadable roster or process table), the answer is refused with
  that reason rather than treated as the operator. This is a guard against a session answering the
  wrong tier by mistake, not authentication. Only decisions raised with `--route` or `--park` are tier-scoped; a
  plain `escalate` is answered and never promoted exactly as before. Answering a decision
  whose task is parked returns that manifest to `queue/` (only when it still waits on this decision) and
  messages the raising session.
- **Timeboxes move a decision up, never down.** Set them in `.ai-sdlc/decisions-config.yaml`:

  ```yaml
  escalationTimeboxMinutes:
    operational: 30
    design: 240
  ```

  The dispatch session runs `cli-decisions promote-expired` on every wake-up. A decision still open
  when its tier's timebox lapses moves up one tier (`operational` to `design`, `design` to `operator`);
  the operator tier is terminal. **Silence never resolves a decision, and nothing moves downward.**
  `promote-expired --dry-run` lists what would move without writing anything.

- **Notifications.** On escalate (with `--route` or `--park`) and on promotion, the receiving tier's
  session, found by role in the roster, gets one message carrying only the decision id, the tier and the
  fixed command `cli-decisions show <id>`; on answer the raising session gets the id and the same
  command. The raiser's free-text summary is never typed into a session (it would be an
  instruction-injection channel); the receiver reads it as data through `show`. Sending is best-effort: a missing or unreachable session is reported in
  the command output and never fails the command. A plain `escalate` without `--route` or `--park`
  records nothing about the chain and sends nothing.
- **Events.** `DecisionRouted` (when raised) and `DecisionEscalated` (on each promotion) go to the
  orchestrator events stream with the decision id, `fromTier`, `toTier` and the task id.

## Durable persistence (AISDLC-546)

`cli-decisions add`, `escalate` and `answer` no longer rely on the fragile local append alone. After
appending to `.ai-sdlc/_decisions/events.jsonl`, the CLI builds a commit with git plumbing (temporary
index; your working tree, index and HEAD are untouched) containing `origin/main` plus the merged ledger,
and pushes it to the dedicated branch `ai-sdlc/decisions-sync` (a draft PR is opened best-effort via
`gh`). No manual sync step is needed, and a Pattern-C parent `git reset --hard origin/main` cannot lose
the decision.

- Numbering is `max(local ledger, origin/main ledger, ai-sdlc/decisions-sync ledger) + 1` after a fetch,
  so a freed DEC-NNNN is never reissued; an explicit `--id` that is already consumed remotely is refused.
- Offline / no `origin` / no `gh`: a warning goes to stderr, the exit code is unchanged and the local
  append is kept (the next successful `add`/`answer` pushes everything).
- Opt out (tests, air-gapped use): `AI_SDLC_DECISIONS_NO_REMOTE_PERSIST=1`.
- The sync push is a programmatic `--no-verify` lease-protected force push to a hard-coded,
  non-configurable dedicated ref (`ai-sdlc/decisions-sync`). This is a documented exception for a
  machine-generated, attestation-exempt commit, not a general pattern for other pushes.
- Untrusted runs (`AI_SDLC_UNTRUSTED_RUN`, or GitHub Actions without `AI_SDLC_INTERNAL_RUN`, read from
  the process environment only) do not persist: a warning is printed and the local append is kept, so
  untrusted input cannot ride into the review-exempt sync PR.
- Each ledger line is validated before the union merge; invalid lines are dropped with a warning.
- Because merging only adds lines, removing a bad record requires cleaning the sync branch AND every
  local ledger (and `origin/main` if it already landed); cleaning one copy alone lets the others
  restore it.
- Merging the sync PR lands the ledger on `main`. Manual ledger syncing is retired; use it only as a
  fallback when the warning above appeared and the remote stayed unreachable.

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

| Field               | Value                                       | Notes                                   |
| ------------------- | ------------------------------------------- | --------------------------------------- |
| `metadata.id`       | `DEC-NNNN`                                  | Stable decision id (never changes)      |
| `metadata.source`   | `subagent-escalation`                       | Identifies dispatched-session origin    |
| `spec.summary`      | One-line question                           | What the subagent needs to know         |
| `spec.body`         | `taskId: AISDLC-NNN\nsourceWorktree: /path` | Resume context, prepended automatically |
| `spec.options`      | Array of `{id, description}`                | Options the subagent surfaced           |
| `spec.contextRef`   | Task id (e.g. `AISDLC-480`)                 | Backlink for audit trail                |
| `metadata.scope`    | `task:AISDLC-NNN` (default)                 | Override via `--scope`                  |
| `decisionLog[0].by` | `dispatched-session:AISDLC-NNN`             | Machine-parseable session id            |

## Mechanism-agnostic contract (AC-3)

`cli-decisions escalate` is a thin CLI wrapper over the same `makeDecisionOpenedEvent` + `appendDecisionEvent` primitives that the interactive `cli-decisions add` uses. It works identically regardless of the dispatch mechanism:

- **Native background-Agent dispatch** (Pattern X v2, `/ai-sdlc orchestrator-tick`): the developer subagent calls the CLI directly from within its worktree.
- **tmux execute-parallel**: each pane session calls the CLI; all writes go to the same `.ai-sdlc/_decisions/events.jsonl` log (append-only, no lock needed for single-writer per call).
- **`claude -p` workers** (Pattern Y / claude-p-shell): workers call the CLI via shell; the event log path is resolved from `--work-dir` (defaults to `cwd` which is the worktree).

## Related runbooks

- `docs/operations/decision-catalog-promotion.md` — general Decision Catalog lifecycle
- `docs/operations/decision-catalog-phase10-adopter-integration.md` — adopter integration guide
- RFC-0035 — Decision Catalog specification
