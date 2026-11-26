# Process-spawn and machine-load cost of our tooling, November 2026

Measurement report for AISDLC-1441. The operator is weighing a rewrite of our CLI in a faster-starting language (for example Rust) and asked for evidence first. A rewrite cannot change GitHub's server-side limits, so the question here is narrower: how much CPU, wall time and machine load do our own processes (node CLIs, `gh` spawns, hooks, git) cost during a normal drain, and how much of that is process startup rather than work.

This is a measurement, not a change. No build work follows without an operator decision (see [Decision requested](#decision-requested)).

## Method

All figures come from [`scripts/measure-process-load.mjs`](../../scripts/measure-process-load.mjs), which has three subcommands and is rerunnable on any macOS or Linux machine:

```bash
# 1. Startup benchmarks (median of 20 runs per case)
node scripts/measure-process-load.mjs bench --runs 20 --out bench.json

# 2. Sample a drain window (24 h by default; Ctrl-C or SIGTERM stops early and still flushes)
node scripts/measure-process-load.mjs sample --duration 24h --interval 1 --out samples.jsonl

# 3. Render the report, with the exact gh call log of the board for the same window
node scripts/measure-process-load.mjs report --samples samples.jsonl --bench bench.json \
  --gh-log .ai-sdlc/dispatch/gh-calls.jsonl
```

- **Startup benchmarks.** Wall time from the parent's monotonic clock; CPU time (user plus system, all threads) from bash's `times` builtin around the child, millisecond resolution. The cases are a compiled no-op (`/usr/bin/true`, a Mach-O binary), the bare node runtime (`node -e 0`), a node CLI entry (`node pipeline-cli/bin/cli-decisions.mjs --help`), `gh --version`, `git --version`, and `gh --version` through the dispatch logging shim (`.ai-sdlc/dispatch/bin/gh`, AISDLC-963). The plain cases run with the shim removed from `PATH` so they measure the real binary and never write to the board's call log.
- **Sampling.** `ps -A` once per second. Each process is classified by its command line (`node:pipeline-cli`, `node:hook`, `node:gh-shim`, `node:toolchain`, `node:mcp`, `node:other`, `gh`, `git`, `shell:ours`, `claude`, `shell`, `other`) and by its parent's class. A process that ends is recorded with the CPU seconds it used inside the window, its wall seconds, and whether it was spawned inside the window. Every tick also records the 1/5/15 minute load average and the machine's cumulative busy CPU from the kernel counters (`os.cpus()`), so the machine total does not depend on catching every process.
- **Known blind spot.** A process that starts and ends between two ticks is never seen, so sampled spawn counts are a lower bound. `gh` is corrected with the exact count from the board's `gh-calls.jsonl` (every hierarchy session logs each `gh` call there); the report uses the larger of the sampled and logged counts.
- **Startup share.** For each class, spawns times the benchmarked startup CPU of the matching case, divided by the class's CPU.
- **Ceiling.** What a faster-starting implementation could remove at most: every node spawn of ours times (node CLI or node runtime startup CPU minus the compiled no-op startup CPU). The same formula for `gh` gives the ceiling for replacing `gh` spawns with in-process HTTP calls, which any language (including the current node runtime) could do.

## Results

Machine: the operator machine (macOS, 12 CPUs, node v22.23.2, gh 2.72.0), during a normal drain with an operator-dispatch session, a planner and several executor and developer sessions running.

**Two windows, and what each covers.**

- **24 h, exact, `gh` only:** the board's `gh-calls.jsonl` for 2026-11-25 22:44Z to 2026-11-26 22:44Z (every `gh` call a hierarchy session made).
- **29.5 min, sampled, everything else:** `sample` from 2026-11-26 22:53Z to 23:22Z. The full 24 h sample was not run in the developer session that produced this report (it outlives the session); the per-hour rates below are this window scaled, and the 24 h rerun is part of the decision requested. The first two minutes of this window overlapped a full `pnpm test` run in this task's worktree, which is where every load sample above 24 comes from (102 of 1663 samples, 22:53:18Z to 22:55:07Z).

### `gh`, 24 h exact

| measure | value |
| --- | --- |
| calls | 27,856 (1,161 per hour; hourly min 177, median 1,395, max 2,147) |
| by session | operator-dispatch 21,411, planner 5,921, executors 524 in total |
| top subcommands | `api rate_limit` 10,876 (39 %), `run list` 3,417, `pr list` 2,259, `run view` 1,697, `api user` 1,644, `api .../commits/main` 1,643 |
| CPU, real `gh` only (52 ms each) | about 1,450 CPU s per 24 h |
| CPU, through the logging shim (95 ms each) | about 2,650 CPU s per 24 h, an upper bound |
| share of the machine's 24 h capacity (12 x 86,400 = 1,036,800 CPU s) | 0.14 % to 0.26 % |

One real API call, `gh api rate_limit` (median of 10): 506 ms wall, 80 ms CPU. Process startup (`gh --version`) is 44 ms of that wall time; the other 460 ms is network and GitHub.

The sampler saw 1,560 `gh` processes in its window where the log holds 916: about 40 % of `gh` calls on this machine come from outside a hierarchy session (developer sessions, tests) and never reach the log.

### Sampled window (generated report)

Window: 2026-11-26T22:53:06.926Z to 2026-11-26T23:22:34.537Z (0.49 h), ps interval 1 s, 12 CPUs, darwin.

#### Startup benchmarks (median of 20 runs)

| case | command | wall ms | CPU ms |
| --- | --- | --- | --- |
| noop-compiled | `true` | 1.0 | 1.0 |
| node-runtime | `node -e 0` | 25.8 | 26.0 |
| node-cli | `node cli-decisions.mjs --help` | 240.9 | 299.0 |
| gh | `gh --version` | 43.9 | 52.0 |
| git | `git --version` | 12.9 | 10.0 |
| gh-via-shim | `gh --version` | 85.5 | 95.0 |

#### Spawns and CPU by executable class

| class | ours | spawns observed | spawns est. | spawns/h | CPU s | wall s (spawned) | startup CPU s | startup share | top parents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| other | no | 4358 | 4358 | 8875.7 | 4206.8 | 24298 | n/a | n/a | other 1757, shell 1431, node:pipeline-cli 477 |
| node:pipeline-cli | yes | 1363 | 1363 | 2776.0 | 2074.4 | 3858 | 407.5 | 19.6% | claude 507, node:pipeline-cli 422, shell 403 |
| claude | no | 12 | 12 | 24.4 | 124.3 | 230 | n/a | n/a | node:hook 11, other 1 |
| gh | yes | 1560 | 1560 | 3177.2 | 89.7 | 684 | 81.1 | 90.4% | shell:ours 980, node:pipeline-cli 540, other 28 |
| node:toolchain | yes | 57 | 57 | 116.1 | 55.3 | 577 | 1.5 | 2.7% | node:hook 33, node:toolchain 14, other 5 |
| node:other | yes | 189 | 189 | 384.9 | 35.7 | 418 | 4.9 | 13.8% | shell 87, node:other 51, node:toolchain 37 |
| node:orchestrator | yes | 62 | 62 | 126.3 | 28.1 | 223 | 18.5 | 66.1% | node:other 34, node:orchestrator 28 |
| git | yes | 384 | 384 | 782.1 | 7.0 | 101 | 3.8 | 54.5% | git 249, shell 108, node:pipeline-cli 23 |
| node:hook | yes | 132 | 132 | 268.8 | 6.7 | 32 | 3.4 | 50.8% | node:hook 76, claude 38, shell:ours 18 |
| shell | no | 352 | 352 | 716.9 | 3.1 | 5203 | n/a | n/a | node:pipeline-cli 130, shell 95, node:toolchain 57 |
| shell:ours | yes | 1088 | 1088 | 2215.9 | 0.3 | 479 | n/a | n/a | node:pipeline-cli 1063, claude 19, shell 6 |
| node:gh-shim | yes | 1 | 1 | 2.0 | 0.1 | 11 | 0.0 | 52.0% | shell 1 |
| node:mcp | yes | 1 | 1 | 2.0 | 0.0 | 215 | 0.0 | 86.7% | claude 1 |

Exact `gh` calls in the window (gh-calls log): 916 (1865.6/h); ps sampling caught 100.0% of them, which is the capture rate applied to the other short-lived classes.

#### Totals

- Machine CPU (kernel counters): 8474 s of 21211 s capacity (40.0% average utilisation); 6632 s attributed to sampled processes.
- Our tooling (node, gh, git, our shell wrappers): 2297 s, 27.1% of observed machine CPU.
- Ceiling for a faster-starting CLI (node startup minus compiled no-op startup, every node spawn): 434 s, 5.1% of machine CPU.
- Ceiling for replacing `gh` spawns with in-process HTTP (gh startup minus no-op, every call): 80 s, 0.9% of machine CPU.

#### Load average (1 min)

Samples 1663; p50 6.10, p90 13.71, p99 58.32, max 65.20.

| load1 range | share of samples |
| --- | --- |
| 0 to 6 | 46.9% |
| 6 to 12 | 41.3% |
| 12 to 18 | 3.5% |
| 18 to 24 | 2.2% |
| 24 to inf | 6.1% |

Reading notes on the generated table:

- `other` (4,207 CPU s, half the machine) is not our tooling: one desktop media application alone used 2,118 CPU s, then the browser (510), the editor (337), the window server, file indexing, and chat and video-call applications. 468 processes shown by `ps` as `(node)` (node processes in their exit state, 108 CPU s) also landed in `other` in this run; the script now classifies them as `node:other`.
- `node:pipeline-cli` is our dominant cost: 1,363 spawns (2,776 per hour), 2,074 CPU s, about 1.5 CPU s per spawn. Its parents are model sessions (507), other pipeline-cli CLIs (422) and shells (403).
- `gh` shows a 100 % capture rate because a real `gh` call lasts about half a second. Sub-second processes are undercounted, not corrected: the shim's node logger (about 43 ms) was seen once although the shim (`shell:ours`) ran 1,088 times, and `node:hook` (132 seen) is a lower bound. Pricing the unseen shim loggers at the benchmark gives about 47 CPU s more in the window.
- Per hour, our tooling used 4,680 CPU s, about 1.3 of the 12 cores on average; the machine as a whole averaged 4.8 cores busy (40 %).

## What a faster-starting CLI could remove, and what remains

**Startup is mostly our own module graph, not the node runtime.** `node -e 0` costs 26 ms of CPU; `node pipeline-cli/bin/cli-decisions.mjs --help` costs 299 ms. About 273 ms of every CLI spawn is loading and compiling our own JavaScript before any work starts. A compiled no-op costs 1 ms.

**Ceiling for a faster-starting implementation of our CLI**, using the sampled window:

| what would go | CPU s in window | share of machine CPU |
| --- | --- | --- |
| every node spawn priced at node CLI startup minus compiled no-op (the generated ceiling) | 434 | 5.1 % |
| of which the node runtime itself (26 ms minus 1 ms per spawn) | about 45 | about 0.5 % |
| of which our module loading (about 273 ms per spawn) | about 390 | about 4.6 % |
| plus the unseen shim node loggers | about 47 | about 0.6 % |
| **upper bound** | **about 480** | **about 5.7 %**, about 0.27 of a core on average |

So a rewrite in a faster-starting language could remove at most about 6 % of the machine's CPU during a drain, about a fifth of our tooling's own CPU (27 % of the machine). Most of that ceiling (the module-loading part) is also reachable inside node, by loading less per command (lazy imports per subcommand, a bundled entry) or caching compiled code (`module.enableCompileCache()`, node 22.1 and later), without a rewrite.

**What a rewrite does not remove:**

- **GitHub latency.** A `gh` API call is 506 ms wall, of which 44 ms is `gh` startup; 91 % is network and GitHub, and GitHub's rate limits are server-side. Replacing `gh` spawns with in-process HTTP (possible in node today) is worth at most 0.9 % of machine CPU in the window and 0.14 % over 24 h. The largest `gh` volume lever is call count: 39 % of the 24 h calls are `gh api rate_limit`.
- **Work inside our CLIs.** `node:pipeline-cli` spends about 80 % of its 2,074 CPU s after startup (the startup share is 19.6 %). Whether a rewrite makes that work faster is a separate question this measurement does not answer.
- **git** (7 CPU s in the window) and **model sessions** (`claude`, 124 CPU s; their cost is wall time waiting on the model, not local CPU).
- **Everything else on the machine** (desktop apps, about half the machine CPU in this window).

**Load.** In the window the 1 min load average had p50 6.1 and p90 13.7 on 12 CPUs; samples above 24 all fall in the two minutes of the overlapping `pnpm test` run. The anecdotal load of 15 to 21 in AISDLC-1379 is consistent with this p90 band. Load counts runnable processes, so it tracks CPU demand: removing at most about 6 % of CPU cannot move a load of 15 to 21 below the core count on its own.

## Decision requested

Escalated to the operator under `dependency-limit:process-startup` as DEC-0439 (filed through `cli-decisions escalate --file --pr`, event-log PR 3089). No build work follows without an operator decision. Options:

- **opt-a (recommended):** no rewrite. File a task to cut node CLI startup inside the current stack (lazy subcommand imports, compile cache) and measure again; that reaches most of the 5 to 6 % ceiling.
- **opt-b:** run the 24 h sample (`sample --duration 24h`) during a normal drain before deciding, and attach the generated report to the decision record.
- **opt-c:** fund a rewrite spike of one hot CLI in a compiled language, accepting that the measured ceiling is about 6 % of machine CPU and none of the GitHub latency.

opt-a and opt-b are compatible.

## Rerunning

Rerun the three commands above for a full 24 h window during a normal drain (for example after the call-volume work lands), keep the generated markdown, and compare the Totals section with the one above. The sampler costs one `ps` spawn per second (its own `ps` children are excluded from the figures); the sampler process itself is excluded too.
