# Usage ledger

**Audience:** operators and adopters who want to see what their model calls consume.
**RFC:** [`RFC-0050`](../../spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md) (Usage Ledger and Evidence-Based Model Routing)
**Companion:** [`model-routing.md`](model-routing.md) covers choosing models from this evidence.

The usage ledger answers three questions: what did each model call consume, how much of the plan allotment is left, and what did a task cost. It reads the records your harness already writes. It does not sit in the path of any call.

**Nothing but counts, ids and attribution is stored.** No prompt, no response, no file content and no tool output is ever read into the ledger, written to it or logged by the ingester. A record holds token counts, a model id, a timestamp, an agent role and the attribution fields described below.

Commands in this document are written as `cli-usage`. From a repository checkout, run `node pipeline-cli/bin/cli-usage.mjs` in its place. The examples use synthetic data from a scratch usage directory; your numbers will differ.

---

## Quick start

```bash
cli-usage ingest            # read new transcripts into the ledger
cli-usage report            # totals for everything on record
cli-usage window            # units used in the current windows
cli-usage snapshot --window weekly --used-pct 42   # calibrate against the provider's percentage
```

---

## What is recorded

One record per model call, appended to a monthly file. Each record has:

- the provider message id (used to skip repeats), the request id and the agent id where the harness reports them, the timestamp, the harness, the provider and the exact model id;
- five token counts (plus a reasoning-token subset of output where reported): input, 5-minute cache write, 1-hour cache write, cache read and output;
- the billing pool (`subscription-interactive`, `agent-sdk-credit`, `api-key`, `codex-plan`, `pay-per-token` or `unknown`; `unknown` is used when the transcript does not make the entry point clear, never a guess);
- the session id, the agent role (`main-session` for the main session, or the subagent type such as `ai-sdlc:developer`) and the attribution scope;
- a `breakdownMissing` flag, set when the harness reported only a session total, so the whole total sits in the input count and the split between token classes is unknown.

For calls in a framework repository the record also holds the repository name, the task id when one can be resolved, and the source file and byte offset.

**Never recorded:** prompt text, response text, file content, tool output, the working directory, or anything from a project that is not a framework repository beyond the counts above. A usage-limit notice found in a transcript yields only a timestamp, a session id and a fixed category (`usage-limit` or `rate-limit`); the notice text is not kept.

**One path caveat.** Framework-scope records keep the transcript source path. The harness names transcript directories after the working directory, so that path encodes the project location and your home directory name. The ledger stays on your machine and is never committed, but treat it as revealing where your projects live before you share a copy. Other-scope records omit the path.

## Where the ledger lives

The ledger is machine-level, because a subscription belongs to an account and spans repositories. It is never committed.

| Path | Content |
| --- | --- |
| `~/.ai-sdlc/usage/ledger-YYYY-MM.jsonl` | One file per month of call records |
| `~/.ai-sdlc/usage/cursors.json` | Byte offset reached in each transcript |
| `~/.ai-sdlc/usage/snapshots.jsonl` | Calibration snapshots you recorded |
| `~/.ai-sdlc/usage/limit-events.jsonl` | Limit notices and harness limit observations |
| `~/.ai-sdlc/usage/prices.jsonl` | Price history |
| `~/.ai-sdlc/usage/usage-config.yaml` | Optional machine-level settings |

Set `AI_SDLC_USAGE_DIR` to use another directory. Every `cli-usage` command, the ingestion hook and the orchestrator honour it. The files are JSON lines, so `jq` reads them directly.

## Two scopes

Each call has one of two scopes, decided from the working directory the harness recorded.

| Scope | When | What is kept |
| --- | --- | --- |
| `framework` | The working directory is inside a repository whose root has both an `.ai-sdlc/` directory and a `.git` entry | Repository, task id, source file and offset, plus the common fields |
| `other` | Everything else, including a directory with `.ai-sdlc/` but no `.git` | Tokens, model, timestamp, harness, session id and agent role only. Repository, task, working directory and source file are omitted |

Reports show both by default. Narrow them with `--scope framework`, `--scope other` or `--scope all`.

To restrict ingestion to framework repositories, set `AI_SDLC_USAGE_SCOPE=framework-only` in the environment where ingestion runs. Transcripts from other projects are then skipped and counted in the `otherScopeSkipped` field of `cli-usage ingest --json`. That count is per transcript file, not per call: a transcript with five other-scope calls adds one. The Codex ingester honours the same variable, but compares it exactly against the lowercase value `framework-only`, so write it in lowercase (the Claude Code ingester also accepts other letter cases).

## Ingestion

### Claude Code

`cli-usage ingest` reads session and subagent transcripts under the harness's projects directory (`$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`). It keeps a byte offset per file, so each run reads only new lines, and it skips any call whose message id is already in the ledger, so running it twice is harmless.

```console
$ cli-usage ingest --projects-dir ./transcripts
Files scanned:   2
Calls written:   17
Repeats skipped: 0
Errors:          0
Limit events:    0

$ cli-usage ingest --projects-dir ./transcripts
Files scanned:   2
Calls written:   0
Repeats skipped: 0
Errors:          0
Limit events:    0
```

| Flag | Meaning |
| --- | --- |
| `--projects-dir <path>` | Read this directory instead of the harness default |
| `--backfill` | Ignore stored cursors and read every transcript from the start |
| `--max-seconds <n>` | Stop starting new work after `n` seconds (default 30) |
| `--json` | Print the result as JSON |

### Backfill

`cli-usage ingest --backfill` reads everything still on disk. Calls already in the ledger are skipped, so a backfill adds only what was missed. It is limited by what the harness has kept: transcripts the harness deleted cannot be recovered.

```console
$ cli-usage ingest --projects-dir ./transcripts --backfill --json
{"filesScanned":2,"callsWritten":0,"repeatsSkipped":17,"errors":0,"limitEvents":0,"otherScopeSkipped":0,"replayTranscriptsSkipped":0,"timedOut":false}
```

### Codex

`cli-usage-codex ingest` reads token counts from Codex session files (`$CODEX_HOME/sessions`, else `~/.codex/sessions`) into the same ledger. It takes `--backfill`, `--sessions-dir <path>` and `--json`.

```console
$ cli-usage-codex ingest --sessions-dir ./codex-sessions
Codex sessions scanned: 0
Calls written: 0
Repeats skipped: 0
Invalid records: 0
Limit observations: 0
Errors: 0
```

### Triggers

Ingestion starts itself from three places and can always be run by hand:

1. The plugin's `Stop` and `SessionStart` hooks. The hook starts `cli-usage ingest` as a detached process with a time limit and exits at once. It starts at most one ingest every 20 seconds.
2. The start of each orchestrator tick.
3. On demand, with the commands above.

Ingestion never blocks or slows a session. If the ingester is not installed or cannot write, the hook does nothing and the session is unaffected. The Claude Code ingester is a no-op in a remote sandbox.

To switch ingestion off, set `AI_SDLC_USAGE_INGEST` to `off` (also `0`, `false`, `no` or `disabled`). A switched-off run reports it:

```console
$ AI_SDLC_USAGE_INGEST=off cli-usage ingest --json
{"filesScanned":0,"callsWritten":0,"repeatsSkipped":0,"errors":0,"limitEvents":0,"otherScopeSkipped":0,"replayTranscriptsSkipped":0,"timedOut":false,"disabled":"switched-off"}
```

Transcripts written during a reviewer replay (see [`model-routing.md`](model-routing.md)) are skipped, because the replay records its own usage.

---

## Reports

### `cli-usage report`

Usage grouped by one or more of `model`, `role`, `task`, `repo`, `pool`, `day` and `window`. Repeat `--group-by` to nest groups. Filter with `--since`, `--until` (ISO dates) and `--scope`. Output formats are `text` (default), `json` and `csv`.

```console
$ cli-usage report --group-by model --group-by role
model              role          calls  input  cache_write_5m  cache_write_1h  cache_read  output    units  cost_usd
-----------------  ------------  -----  -----  --------------  --------------  ----------  ------  -------  --------
claude-haiku-4-5   main-session      4  1,460          20,000               0     238,000   3,720   22,953   $0.0689
claude-opus-4-6    main-session      4  1,420          20,000               0     226,000   3,640  112,033   $0.3361
claude-sonnet-4-6  main-session      9  2,380          30,000               0     314,000   6,060  101,580   $0.3047
TOTAL                               17  5,260          70,000               0     778,000  13,420  236,567   $0.7097
Units are weighted tokens. The weights are a proxy for how the provider counts consumption, not a published conversion. Weights derived from the price history (reference model claude-sonnet-4-20250514).
```

Other groupings use the same columns:

```console
$ cli-usage report --scope framework --group-by task --format csv
task,calls,input,cache_write_5m,cache_write_1h,cache_read,output,units,cost_usd,cost_status
DEMO-1,12,4260,60000,0,678000,10920,200566.6666666667,0.6017,priced
TOTAL,12,4260,60000,0,678000,10920,200566.6666666667,0.6017,priced

$ cli-usage report --scope other --group-by repo --group-by task
repo    task    calls  input  cache_write_5m  cache_write_1h  cache_read  output   units  cost_usd
------  ------  -----  -----  --------------  --------------  ----------  ------  ------  --------
(none)  (none)      5  1,000          10,000               0     100,000   2,500  36,000   $0.1080
TOTAL               5  1,000          10,000               0     100,000   2,500  36,000   $0.1080

$ cli-usage report --group-by pool
pool                      calls  input  cache_write_5m  cache_write_1h  cache_read  output    units  cost_usd
------------------------  -----  -----  --------------  --------------  ----------  ------  -------  --------
subscription-interactive     17  5,260          70,000               0     778,000  13,420  236,567   $0.7097
TOTAL                        17  5,260          70,000               0     778,000  13,420  236,567   $0.7097
```

(The `Units are weighted tokens...` line follows every text report; it is left out of the later examples.) The `other` rows show `(none)` for repository and task, because that scope does not keep them.

`--group-by day` buckets by UTC day. `--group-by window` buckets by the windows in your usage config, labelled with each window's start.

`cost_usd` is the API-equivalent cost: what the same tokens would cost at list prices outside the plan. A call is priced with the price row in effect at the call's timestamp, so an old report does not change when a price does. A model with no price is shown as `unpriced` and left out of the cost. It is never priced as a different model.

### `cli-usage window`

Units used in each configured window, the implied allotment (see below) and the projected time to the limit at the current rate.

```console
$ cli-usage window
session window (5h)
  no window is open; no calls in range
  implied allotment: unknown (record one with: cli-usage snapshot)
weekly window (168h)
  window:  2026-09-24T16:28:11.827Z to 2026-10-01T16:28:11.827Z
  used:    236,567 units over 17 calls
  implied allotment: 563,254 units (42.0% used)
  rate:    5,913 units/hour; projected time to the limit 55.2 hours
```

`--format json` gives the same data as JSON.

### `cli-usage task <id>`

Tokens and units for one task, split by role, so the cost of a task is one number. Task ids are resolved for framework scope from the worktree path (`.worktrees/<task-id>`), then the branch name, then the `.active-task` file. A call with no resolvable task is recorded without one.

```console
$ cli-usage task DEMO-1
Task DEMO-1
role               calls  input  cache_write_5m  cache_write_1h  cache_read  output    units  cost_usd
-----------------  -----  -----  --------------  --------------  ----------  ------  -------  --------
ai-sdlc:developer      4  1,600          16,000               0     200,000   4,800   65,600   $0.1968
main-session          12  4,260          60,000               0     678,000  10,920  200,567   $0.6017
TOTAL                 16  5,860          76,000               0     878,000  15,720  266,167   $0.7985
```

It takes `--format text|json|csv`.

### `cli-usage context`

Context overhead per session: the size of the context at the first call (the fixed prefix each later turn re-reads), the number of turns and the total cache read. Cache reads dominate consumption, so this is where reductions are found. Options: `--since`, `--until`, `--scope`, `--limit <rows>` (default 20) and `--format text|json`.

```console
$ cli-usage context --limit 5
session  agent         scope      first_call_tokens  turns  total_cache_read  path
sess-a   main-session  framework  45,300             12     678,000           .../projects/p1/sess-a.jsonl
sess-b   main-session  other      22,200             5      100,000           -
```

(The path is shortened here. It is shown only for framework scope.) For a subagent row the `agent` column shows the subagent id rather than the role, so a main session and its subagents appear as separate rows.

---

## Weighted units

The provider reports plan consumption as a percentage of a window and publishes no conversion from tokens. Reports therefore weigh each call in units. One input token of the reference model is one unit; every other token class and model is weighed against it using the price history in force. Cache reads weigh far less than output, and a larger model weighs more than a smaller one.

**Units are a proxy.** They approximate how the provider counts consumption and are not a published conversion. Every report that shows units says so, and the footer names the weights in use.

Override the weights in the usage config (see [Configuration](#configuration)) if you have better numbers. An override is named in the report footer, for example `overridden: modelFamilies.opus`.

## Allotment tracking

### Snapshots

A snapshot is a calibration point: the percentage the provider shows for a window at a moment you read it.

```console
$ cli-usage snapshot --window weekly --used-pct 42
Recorded weekly snapshot: 236,567 units at 42% implies an allotment of 563,254 units.
```

When the new snapshot's implied allotment differs from the previous one by more than the tolerance, the command prints a second line. In a scratch ledger with a 20% snapshot followed by a 50% snapshot over the same units:

```console
$ cli-usage snapshot --window weekly --used-pct 20 --at 2026-09-29T12:00:00Z
Recorded weekly snapshot: 68,000 units at 20% implies an allotment of 340,000 units.
$ cli-usage snapshot --window weekly --used-pct 50
Recorded weekly snapshot: 68,000 units at 50% implies an allotment of 136,000 units.
Probable allotment change: -60.0% against the previous snapshot.
```

`--window` is the name of a window in your config (`session` and `weekly` by default). `--used-pct` is above 0 and at most 100. `--at <time>` records an earlier observation. The command divides the units consumed in that window by the percentage to get an implied allotment. A snapshot taken when the window held no calls cannot be calibrated and is not recorded.

### Reading the allotment series

```console
$ cli-usage allotment
window  time                      used_pct  units    implied_allotment  change  note
weekly  2026-09-30T20:28:25.000Z  30.0      117,113  390,378            -
weekly  2026-10-01T16:28:10.993Z  42.0      236,567  563,254            44.3%   probable allotment change
Change tolerance 25%, compared only when the model mix is similar.
Units are weighted tokens. The weights are a proxy for how the provider counts consumption, not a published conversion.
```

Each row is one snapshot with its implied allotment. When two snapshots of one window differ by more than the tolerance (25% by default) and their model mixes overlap enough (80% by default), the later row is flagged as a probable allotment change. Snapshots with very different model mixes are not compared. Use `--window <name>` for one window and `--format json` for JSON. The series is the record of how your allotment has moved over time.

The more snapshots you record, at varied points in the window, the more useful the series. Where a harness writes limit information into its session data, the ingester records it as a snapshot automatically.

### Limit events

Limit notices found in transcripts are written to `limit-events.jsonl` (created when the first event is recorded) with a timestamp, a session id and a category (`usage-limit` or `rate-limit`). The ingest summary counts them in `Limit events`, and the operator TUI usage pane shows the most recent one. There is no separate `cli-usage` view for them; read the file with `jq`:

```bash
f="${AI_SDLC_USAGE_DIR:-$HOME/.ai-sdlc/usage}/limit-events.jsonl"
[ -f "$f" ] && jq . "$f"
```

The file does not exist until the first event, so the guard keeps the command quiet on a machine that has seen none.

---

## Price feed

Prices come from public sources rather than a hand-kept table. `cli-usage prices refresh` contacts two third-party aggregators:

- the OpenRouter public models endpoint, `https://openrouter.ai/api/v1/models`;
- the LiteLLM price file, `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`, read from the `main` branch of a GitHub repository (an unpinned branch, so its content can change at any time).

Neither is a provider's own price list. Fetched prices are treated as untrusted input: they are validated, and they are held rather than used when sources disagree or a price jumps (see the rules below). They are still important, because the prices feed the weights behind units, scorecards and the allotment math.

| Command | What it does |
| --- | --- |
| `cli-usage prices refresh` | Fetch public price sources and append changed prices to the history |
| `cli-usage prices list` | Show the price in force per model, its source and age, and any held row |
| `cli-usage prices confirm <model>` | Promote a held price row to active |
| `cli-usage prices set <model> ...` | Write a manual price row, which wins over fetched rows |

```console
$ cli-usage prices refresh
source openrouter: 16 models
source litellm: 14 models
appended=0 held=0 unchanged=16 incomplete=0 rejected=0

$ cli-usage prices list
claude-opus-4-6  in=5 out=25 read=0.5 w5m=6.25 w1h=10  source=anthropic-published-price-list  age=1d
claude-sonnet-4-6  in=3 out=15 read=0.3 w5m=3.75 w1h=6  source=anthropic-published-price-list  age=1d
...
```

Prices are per million tokens. `refresh` is a plain GET of those two public URLs and sends nothing about your repository. The orchestrator also runs it at most once a day, at the start of a tick; there is no setting that turns that daily refresh off, so to avoid this network egress do not run the orchestrator loop, and do not run `prices refresh`. Without a refresh, the last known prices (or manual rows from `prices set`) stay in force, and `prices list` marks them `STALE` after 14 days. `refresh` takes `--source <name>`, `--json`, `--tolerance` (default 0.05) and `--change-factor` (default 3).

A fetched row is rejected if a price is zero, negative or not a number. A row is held, and not used, when two sources disagree by more than the tolerance or a price moves by more than the change factor against the last row. A held row shows in `prices list` with the command to confirm it. If every source is unreachable, the last known prices stay in force, and `prices list` marks them `STALE` after 14 days (change with `--stale-days`).

A manual row needs all five prices:

```console
$ cli-usage prices set claude-example-model --input 1 --output 5 --cache-read 0.1 --cache-write-5m 1.25 --cache-write-1h 2
Manual price written for claude-example-model effective 2026-10-01.
```

`--effective-from <date>` sets when the row starts to apply.

---

## Configuration

Settings are optional. `cli-usage` reads the first of these that exists and validates:

1. `usage-config.yaml` in the usage directory (this machine only).
2. `.ai-sdlc/usage-config.yaml` as committed on the base branch (`origin/main`), read with `git show` and never from the working tree, so a branch cannot change its own report settings.
3. The built-in defaults: a 5-hour `session` window (opens at first use) and a 168-hour `weekly` window (trailing).

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: UsageConfig
spec:
  plan:
    name: Max 20x
    monthlyPriceUsd: 200
  windows:
    - name: session
      lengthHours: 5
      mode: first-use
    - name: weekly
      lengthHours: 168
      mode: fixed
      anchor: '2026-09-28T09:00:00Z' # your plan's reset time
  weights:
    modelFamilies:
      opus: 5 # multiplier per model family (substring of the model id)
  allotmentTolerance: 0.25
  modelMixSimilarity: 0.8
  scorecardMinTasks: 30
```

Window modes: `first-use` opens at the first call after the previous window ended, `fixed` repeats from an `anchor`, and `trailing` is the last `lengthHours` before now. `weights.tokenClasses` can override the per-class weights (`input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`). The schema is [`usage-config.v1.schema.json`](../../spec/schemas/usage-config.v1.schema.json).

A config that fails validation is skipped with a warning and the next source is tried. A bad config never stops a report.

## Operator TUI

The operator TUI (`AI_SDLC_TUI=experimental`) has a usage pane, opened with `u`, that shows the window view, the top consumers of the current weekly window, the latest limit event and any suspected allotment change.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `report` shows no rows | Nothing ingested yet, or a different `AI_SDLC_USAGE_DIR` | Run `cli-usage ingest`, and check `echo $AI_SDLC_USAGE_DIR` is the same in every shell and hook |
| `ingest` output has `"disabled":"switched-off"` | `AI_SDLC_USAGE_INGEST` is `off` | Unset it, or set it to something else |
| `ingest` writes nothing in a remote sandbox | The ingester is a no-op there by design | Ingest from the machine that runs the harness |
| Older sessions are missing | A run stopped at its time limit before reaching them | Run `cli-usage ingest --backfill` (or `ingest` again, which continues from the cursors) |
| `Calls written: 0` on every run | Everything is already in the ledger | Nothing to do |
| Calls from one project are missing | `AI_SDLC_USAGE_SCOPE=framework-only` is set and the project root has no `.ai-sdlc/` directory or no `.git` entry | Unset it, or add what is missing if the project should count as framework |
| A call has no task id | The path, branch and `.active-task` file did not name one, or the call is `other` scope (a repository with `.ai-sdlc/` but no `.git` is `other`) | Expected for main-session work outside a task worktree; check the repository root has both |
| `implied allotment: unknown` | No snapshot for that window | `cli-usage snapshot --window <name> --used-pct <n>` |
| `No usage in the weekly window at that time, so it cannot be calibrated.` | The `--at` time is before any recorded call | Use a later time, or ingest older transcripts first |
| `probable allotment change` | Implied allotment moved more than the tolerance with a similar model mix | Check whether your plan or the provider's accounting changed; raise `allotmentTolerance` if it is noise |
| `Ignored the machine-level usage config: ...` | The config failed schema validation | Fix the named field; the base-branch file or defaults apply meanwhile |
| Cost shows `unpriced` for a model | No price row for that model id | `cli-usage prices set <model> ...` or `cli-usage prices refresh` |
| `No held price row for <model>.` | `prices confirm` ran when nothing is held | Run `cli-usage prices list` to see held rows |
| Prices marked `STALE` | No successful refresh within the stale limit | Run `cli-usage prices refresh` and check network access |
| Unit totals look wrong | Units are a proxy and the default weights follow list prices | Set explicit weights in the usage config |

## Related

- [`model-routing.md`](model-routing.md): choosing models from this evidence.
- [`billing-and-cost-optimization.md`](billing-and-cost-optimization.md): billing pools and how to spread work across them.
- [`RFC-0050`](../../spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md): the design and its rationale.
