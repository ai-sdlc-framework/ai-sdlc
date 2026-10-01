# Model routing

**Audience:** operators who decide which model runs which agent role.
**RFC:** [`RFC-0050`](../../spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md) (Usage Ledger and Evidence-Based Model Routing)
**Companion:** [`usage-ledger.md`](usage-ledger.md) covers the usage data this evidence is built from.

Model routing lets a repository say which model each agent role uses, and gather evidence on whether a cheaper model does the job as well. This document separates what ships today from what does not. The weekly proposal, its approval and the automatic revert are described in [Planned behaviour](#planned-behaviour-not-yet-available); no command for them exists yet.

Commands are written as `cli-usage` and `ai-sdlc-pipeline`. From a repository checkout, run `node pipeline-cli/bin/cli-usage.mjs` and `node pipeline-cli/bin/ai-sdlc-pipeline.mjs` in their place. The examples use synthetic data.

No prompt, response, file content or tool output is stored by any of this. The assignment log, scorecards and replay results hold ids, counts, model names and verdict counts only.

---

## Without a table

A repository with no `.ai-sdlc/model-routing.yaml` on its base branch behaves as it always has: developer, code reviewer and test reviewer use `claude-sonnet-4-6`, and the security reviewer uses `claude-opus-4-6`. Nothing changes until you commit a table.

```console
$ ai-sdlc-pipeline resolve-model developer --task-id DEMO-1 --skip-log
{
  "model": "claude-sonnet-4-6",
  "arm": "default",
  "reason": "default"
}
```

## The table

The table lives at `.ai-sdlc/model-routing.yaml`. It is read from the base branch only (`origin/main`), using `git show`, never from the working tree. A pull request therefore cannot route its own development or review to a different model by editing the table in its own diff. The change has to land on the base branch first.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
metadata:
  name: model-routing
spec:
  strength: [claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-6]
  exploreShare: 0.5 # 0.10 is a more realistic share; 0.5 lets small examples show both arms
  salt: demo-1
  cells:
    developer:
      chore: { model: claude-sonnet-4-6, candidates: [claude-haiku-4-5] }
      '*': { model: claude-sonnet-4-6 }
    code-reviewer:
      '*': { model: claude-sonnet-4-6 }
    security-reviewer:
      '*': { model: claude-opus-4-6 }
```

| Field | Meaning |
| --- | --- |
| `strength` | Every model in the table, weakest first. This order defines what "stronger" means. Every model named in a cell or in `candidates` must appear here |
| `exploreShare` | Share of eligible tasks sent to a candidate instead of the cell's model, from 0 to 1. Default 0 |
| `salt` | Mixed into the assignment hash. Changing it reshuffles which tasks are explored |
| `cells` | Role, then task class, then a cell. Use `'*'` as the class to cover every class of that role |
| `cell.model` | The model for the role and class |
| `cell.candidates` | Models that may receive the exploration share. Not allowed on `security-reviewer` |
| `evidence` | Optional notes on what justified a cell, keyed `<role>.<taskClass>` |

Task class is the estimation class in the task's frontmatter `class:` field (`bug`, `feature`, `chore`), or `uncategorized` when none is recorded. The schema is [`model-routing.v1.schema.json`](../../spec/schemas/model-routing.v1.schema.json).

**A broken table is ignored, not half-applied.** If the file is missing, is not valid YAML, fails the schema, names a model that is not in `strength`, puts `candidates` on the security reviewer, or sets the security reviewer to a model weaker than `claude-opus-4-6`, the built-in defaults apply to every role:

```console
$ ai-sdlc-pipeline resolve-model developer --task-id DEMO-3 --task-class chore --source-kind backlog --skip-log
{
  "model": "claude-sonnet-4-6",
  "arm": "default",
  "reason": "default"
}
```

(That output is from the table above with `candidates` added to the security reviewer. DEMO-3 is explored under the valid table, so the `default` arm here shows the whole table was ignored.)

## How a model is chosen

`resolveModel` is consulted wherever a model is chosen for a role: the step tools that build developer and reviewer prompts, and the spawner's per-role defaults. The first match wins:

1. **Override.** A valid entry in the overrides file (see [Overrides](#overrides)).
2. **Exploration.** An eligible task whose draw falls inside `exploreShare` (see below).
3. **The table cell** for the role and task class.
4. **The wildcard cell** (`'*'`) for the role.
5. **The built-in default** for the role.

You can ask for any resolution directly:

```console
$ ai-sdlc-pipeline resolve-model developer --task-id DEMO-1 --task-class chore --source-kind backlog
{
  "model": "claude-sonnet-4-6",
  "arm": "table",
  "reason": "table"
}
```

The `arm` is `table`, `explore`, `override` or `default`. Options: `--task-id`, `--task-class`, `--source-kind backlog|gh-issue`, `--iteration`, `--artifacts-dir` and `--skip-log` (resolve without writing the assignment log).

## Exploration

A cell with `candidates` sends a share of eligible tasks to a candidate. This is how the framework gathers evidence on whether a cheaper model is good enough.

```console
$ ai-sdlc-pipeline resolve-model developer --task-id DEMO-3 --task-class chore --source-kind backlog
{
  "model": "claude-haiku-4-5",
  "arm": "explore",
  "reason": "explore"
}
```

The assignment is deterministic. A hash of the task id, the role and the table's `salt` picks both the arm and, if there are several, the candidate. The same task always resolves the same way, so an assignment can be audited afterwards and a task keeps its arm across later iterations.

**Who is eligible**

- Tasks from the backlog (`--source-kind backlog`) that have a task id, for a role whose cell lists `candidates`.

**Who is never explored**

- Work from external issues (`gh-issue`) is never explored:

  ```console
  $ ai-sdlc-pipeline resolve-model developer --task-id DEMO-2 --task-class chore --source-kind gh-issue
  {
    "model": "claude-sonnet-4-6",
    "arm": "table",
    "reason": "table"
  }
  ```

- The security reviewer is never explored. `candidates` on that role makes the whole table invalid.
- A task with no task id.
- A role or class whose cell has no `candidates`.

**Turning exploration off.** Remove `candidates` from the cells (or set `exploreShare` to 0). Resolution then returns the table cell for every task. Land the change on the base branch like any table edit.

## The assignment log

Every resolution made with a task id is appended to `$ARTIFACTS_DIR/_routing/assignments.jsonl`, one line each:

```json
{"ts":"2026-10-01T16:29:13.882Z","taskId":"DEMO-3","role":"developer","taskClass":"chore","iteration":1,"model":"claude-haiku-4-5","arm":"explore","reason":"explore"}
```

This log is what makes an outcome attributable to a model and separates an explored comparison from a pinned one. Writing it never changes the model that is returned, and a write failure is ignored.

**Set `ARTIFACTS_DIR`.** The resolver's default when `ARTIFACTS_DIR` is unset is `<project>/.ai-sdlc/artifacts`, while `cli-usage scorecard` and `cli-usage replay-corpus build` default to `<project>/artifacts`. Setting `ARTIFACTS_DIR` once makes the assignment log, the scorecard and the replay corpus agree on one place.

## Overrides

The resolver also reads `$ARTIFACTS_DIR/_routing/overrides.json`:

```json
{
  "version": 1,
  "overrides": [{ "role": "developer", "taskClass": "chore", "model": "claude-opus-4-6" }]
}
```

An override can only select a stronger model. It is honoured only when its model is in the table's `strength` list and is strictly stronger than the cell's own model; any other entry is ignored. With the table above, an override of the code reviewer to `claude-haiku-4-5` (weaker than the cell's `claude-sonnet-4-6`) changes nothing, while the developer override to `claude-opus-4-6` takes effect:

```console
$ ai-sdlc-pipeline resolve-model developer --task-id DEMO-3 --task-class chore --source-kind backlog --skip-log
{
  "model": "claude-opus-4-6",
  "arm": "override",
  "reason": "override"
}

$ ai-sdlc-pipeline resolve-model code-reviewer --task-id DEMO-3 --task-class chore --source-kind backlog --skip-log
{
  "model": "claude-sonnet-4-6",
  "arm": "table",
  "reason": "table"
}
```

A missing or unreadable overrides file is treated as empty. Nothing in the framework writes this file yet (see [Planned behaviour](#planned-behaviour-not-yet-available)).

---

## Scorecards

`cli-usage scorecard` joins the usage ledger, the reviews ledger (`.ai-sdlc/reviews/`) and the assignment log by task and role. For each role, model and task class it reports the number of tasks, the first-pass approval rate, mean iterations, mean blocking findings, mean units per task and how many tasks were explored. Run it from the repository you want to score; it reads only that repository's framework-scope usage.

```console
$ cli-usage scorecard
role          model              class          tasks  first_pass  mean_iter  mean_blocking  mean_units  explored  model_source    note
developer     claude-sonnet-4-6  uncategorized  1      100% (1/1)  1.0        0.0            65,600      0         usage-majority  insufficient
main-session  claude-haiku-4-5   uncategorized  1      -           -          -              200,567     0         usage-majority  insufficient
Cells with fewer than 30 tasks are insufficient and are not used for a table change.
Tasks with usage but no review outcome (excluded from approval rates): 0.
Units are weighted tokens. The weights are a proxy for how the provider counts consumption, not a published conversion. Weights derived from the price history (reference model claude-sonnet-4-20250514).
```

First-pass approval means every reviewer approved at iteration 1 with no critical or major finding. Every rate is shown with its count.

**`insufficient`** marks a cell with fewer than 30 tasks (the default; `scorecardMinTasks` in the [usage config](usage-ledger.md#configuration) changes it). An insufficient cell is shown for information and must not be used to change the table: a handful of tasks cannot tell a real difference from chance.

`model_source` says how the row's model was determined: from the assignment log when the task has an entry there, otherwise from the model that made most of the task's calls.

| Flag | Meaning |
| --- | --- |
| `--role <name>` | Only this role, for example `developer` |
| `--since <date>` | Include calls at or after this ISO date |
| `--format text\|json\|csv` | Output format |
| `--replay-results <file>` | Add reviewer rows from a replay results file (repeatable) |
| `--write-evidence <dir>` | Write one JSON evidence file per cell into the directory |

`--write-evidence` writes the numbers behind each row, which is what a table change should cite in the table's `evidence` field.

## Reviewer replay

Reviewer models cannot be compared on live work without risk, so they are compared offline. Replay runs a reviewer role with a candidate model over past reviewed commits and scores its verdict (block or approve) against what the review history says happened.

**Spending usage.** A replay makes real model calls and spends your allotment. It takes an explicit item count and unit budget, refuses to run without `--confirm-spend`, and stops when either cap is reached. `--dry-run` lists what would run and calls no model.

### 1. Build the corpus

```console
$ cli-usage replay-corpus build
Replay corpus: 4 item(s) (known-defect 1, clean 3).
Skipped: not-resolved=0 not-first-pass-clean=3 duplicate=0 invalid-record=0 unreachable=0 empty-diff=0
Wrote <artifacts>/replay/corpus.json
```

The corpus is built from the reviews ledger of the current checkout. Each reviewed commit gets a label:

- **`known-defect`**: a reviewer role recorded a critical or major finding on the commit, and a later iteration of the same task was approved by every recorded reviewer with no critical or major finding. This is an inference from the ledger, not proof that the finding was a real defect or that the later change fixed it.
- **`clean`**: approved on the first pass with no critical or major finding.

Commits already on the base ref (an empty diff) are skipped. Options: `--base-ref <ref>` (default `origin/main`) and `--out <file>`.

### 2. Preview a replay

```console
$ cli-usage replay --role code --model claude-haiku-4-5 --max-items 5 --max-units 100000 --dry-run
Dry run: no model is called. 2 of 2 corpus item(s) for role code would be replayed with claude-haiku-4-5.
  DEMO-1  3b2eac4a68dd  known-defect
  DEMO-2  cf24ccfb6f7e  clean
Estimate: no reviewer usage is on record, so no unit estimate is available.
```

### 3. Budget flags

| Flag | Meaning |
| --- | --- |
| `--role code\|test\|security\|correctness` | Reviewer role to replay (required) |
| `--model <id>` | Candidate model (required) |
| `--reference-model <id>` | Also replay a reference model on the same items |
| `--max-items <n>` | Stop after this many corpus items (required) |
| `--max-units <n>` | Stop once this many weighted units are spent (required) |
| `--corpus <file>` | Corpus file (default `<artifacts>/replay/corpus.json`) |
| `--dry-run` | List the items and an estimate; call no model |
| `--confirm-spend` | Authorize the printed capped unit cost. Required for a real run |
| `--off-peak` | Run only inside an off-peak window |
| `--off-peak-window <TZ@HH-HH[@Day,Day]>` | An off-peak window, repeatable |

Without `--confirm-spend` a run prints the cap and stops:

```console
$ cli-usage replay --role code --model claude-haiku-4-5 --max-items 5 --max-units 100000
Spend cap: up to 100,000 units (--max-units); no reviewer usage is on record, so there is no estimate. 2 item(s) x 1 model(s).
Refusing to spend model usage without --confirm-spend. No model was called.
```

With `--off-peak` and `--off-peak-window`, a run started outside the window is deferred and calls no model.

### What a replay reports

For each model, a replay scores recall on known-defect commits (the share it blocked), the false-block rate on clean commits (the share it blocked wrongly) and units per review. Results are written to `<artifacts>/replay/results-<role>-<run>.json`. Feed them to `cli-usage scorecard --replay-results <file>` to see reviewer rows next to the developer rows.

Replay reviews are never written to the reviews ledger, the transcript leaves or any attestation, and the usage ingester skips transcripts made during a replay so the spend is not counted twice.

### Sandbox and its limits

Each replayed review runs `claude -p` with read-only tools only (Read, Grep, Glob), no MCP, user-level settings only, no slash commands, no session transcript and prompts denied. It never uses `bypassPermissions`. If the installed `claude` lacks any of these flags, the command refuses to run. The commit is checked out in a throwaway local clone with no remote, hooks off and user git config off. Every `.claude/`, `.mcp.json` and `CLAUDE.md` the commit carries is stripped, symlinks become plain files, and `CLAUDE_PROJECT_DIR`, `CLAUDECODE` and `AI_SDLC_*` are dropped from the environment. Only the diff comes from the replayed commit, and it is marked untrusted in the prompt.

The residual risk is stated in `cli-usage replay --help`: the session is still a model reading untrusted code with read-only tools. A malicious diff could try to mislead the verdict or ask the model to echo file contents it can read inside the clone. Replay only commits from repositories you trust.

---

## Planned behaviour (not yet available)

**This section describes rules from RFC-0050. The commands and automation for them have not shipped, so no command is shown.** Do not expect the table to change by itself, and do not look for a proposal command today. What ships today is the evidence (scorecards, replay), the table, exploration, and the override reader above. Table edits are made by hand, by pull request to the base branch.

The rules the RFC sets for changing the table, once that automation exists:

**Moving to a cheaper model: proposed, then approved.**

- A weekly job evaluates each cell's candidates. A candidate qualifies when it has at least **30 compared tasks** and its first-pass approval rate is no more than **5 points** below the cell's current model over the same period. For a reviewer role, replay recall must be no more than 5 points lower and the false-block rate no more than 5 points higher.
- Every qualifying change goes into one Decision (RFC-0035) with the evidence attached. Approving it produces a pull request that edits the table and records the evidence reference.
- **Silence leaves the table unchanged.** A proposal that nobody approves has no effect.
- The proposal is computed at current prices, and it reports any cell whose applied change is no longer cheaper.

**Moving back to a stronger model: automatic.**

- When a cell's model, after a change, shows a first-pass approval rate more than 5 points below the rate recorded in the evidence that justified the change, over at least 30 tasks, that cell is reverted to its previous model through the overrides file. The revert is recorded, announced through a Decision, and stays until a table change supersedes it.
- **Overrides can only select a stronger model.** An override may never move a cell to a cheaper or equal one. The resolver already enforces this when it reads the overrides file (see [Overrides](#overrides)).

The 30-task and 5-point values are the defaults, and the RFC makes both configurable.

Until this automation ships, you can do the same by hand: read `cli-usage scorecard`, apply the same bar (30 tasks, 5 points), and commit a table change. To step a cell back, edit the table to the stronger model.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every role resolves with `arm: default` | No valid table on the base branch | Commit `.ai-sdlc/model-routing.yaml` to `origin/main`, and check it against the rules in [The table](#the-table) |
| Table edit has no effect on a branch | The table is read from the base branch, not the working tree | Land the change on `origin/main` |
| No task is ever explored | No `candidates`, `exploreShare` is 0, or the task is not from the backlog | Check the cell, the share and `--source-kind` |
| An override is ignored | Its model is not in `strength`, or is not stronger than the cell's model | Choose a stronger model that is in `strength` |
| Scorecard shows `insufficient` | Fewer than 30 tasks in the cell | Gather more tasks; do not change the table on this evidence |
| Scorecard shows no explored tasks | The assignment log is in a different directory from the one the scorecard reads | Set `ARTIFACTS_DIR` to one directory for both |
| `The corpus has no items for role <role>.` | No reviewed commits for that role in the reviews ledger | Build the corpus from a checkout with review history |
| `Refusing to spend model usage without --confirm-spend.` | A real replay needs explicit authorization | Review the printed cap, then add `--confirm-spend` |

## Related

- [`usage-ledger.md`](usage-ledger.md): the usage ledger, reports and allotment tracking.
- [`RFC-0050`](../../spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md): the design and its rationale.
