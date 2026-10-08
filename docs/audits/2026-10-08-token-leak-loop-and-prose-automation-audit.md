# Token leak audit: loops, idle polling and prose automation (2026-10-08)

Planner audit requested by the operator on 2026-10-08 after the weekly usage reached 87% with idle executors at 55% context. Method: every Claude Code transcript under `~/.claude/projects` for the last 7 days, costed at API list prices as a weight (cache read $0.30/M Sonnet, $1.50/M Opus-class, $0.10/M Haiku; output $15/$75/$5). Subscription billing is not linear in these numbers, but the ratios are what matter. The audit scripts (`audit.mjs`, `audit7.mjs`, `audit8.mjs`) are reproduced in AISDLC-765.

## 1. Where the tokens went (7 days, 2026-10-01 to 2026-10-08 08:00 PDT)

Total API-weight: about $15,000 over 59,000 calls. By model: Opus 5.5 $5,253, Sonnet 5.5 $4,299, Opus 4.8 $3,339 (local-trades executor loops), Fable 5.1 $2,090 (planners), Haiku $1.

| Bucket | Cost | Share | Calls | Avg context |
|---|---|---|---|---|
| local-trades `execute` loop sessions (Opus 4.8) | $3,586 | 24% | 7,046 | 389k |
| ai-sdlc `execute` loop sessions (executors running Step 0-13 inline) | $2,761 | 18% | 15,125 | 334k |
| ai-sdlc subagents (developer, reviewers: the actual work) | $2,423 | 16% | 17,519 | 105k |
| ai-sdlc-io operator-dispatch (Opus), 99% idle | $1,347 | 9% | 1,714 | 484k |
| ai-sdlc operator-dispatch | $1,011 | 7% | 2,185 | 208k |
| ai-sdlc executor loop bodies (claim, verdict, messaging) | $849 | 6% | 1,743 | 397k |
| local-trades subagents | $689 | 5% | 4,813 | 81k |
| ai-sdlc-io executors, 98% idle | $473 | 3% | 3,115 | 446k |
| planners (Fable) | $421 | 3% | 462 | 478k |

Per task PR merged (95 in ai-sdlc, 68 in local-trades): about $29 of orchestration prose-following plus $25 of subagent work in ai-sdlc; $53 plus $10 in local-trades. Orchestration costs more than the work it orchestrates, and it runs about 160 LLM round-trips per task.

## 2. The idle leak (last 24 h)

In the 24 hours to 07:45 PDT 2026-10-08: $3,327 total, of which $2,288 (69%) was six sessions polling an empty board: the ai-sdlc-io dispatch (Opus, 690k context, 1,690 calls, $1,320) and five executors (250k to 560k context, about 1,380 calls each). Each wake is "claim, `{"claimed":false}`, `ScheduleWakeup` 60s" with about 8 calls per tick, zero clears, six compactions each. Cost per idle hour: about $13 per Sonnet executor, $93 for the Opus dispatch, roughly $160 per hour for nothing. Twelve such sessions exist across two projects (ai-sdlc and ai-sdlc-io).

Root causes:

1. `executor.md` empty-queue path (`ai-sdlc-plugin/commands/executor.md:175-198`) schedules a 30 s wake (no project sets `emptyQueueHibernateSec`) and never clears; context only grows between tasks.
2. The live dispatch sessions run the installed plugin 0.24.0 body, which ends every tick with `ScheduleWakeup` 60s and no clear. The repo body (AISDLC-741, PR #1246) self-clears every tick but has not been released.
3. Dispatch has no idle interval: an empty board is polled at the busy rate.
4. Dispatch runs on Opus for a tick that is `cli-hierarchy tick` plus message relay.
5. The ai-sdlc-io hierarchy (7 sessions) has had an empty board for its whole life.

## 3. Loop inventory

| Loop | Where | Interval idle / busy | Model | Calls per idle tick | Clears | Note |
|---|---|---|---|---|---|---|
| executor x5 per project | `executor.md:175-197` | 30 s / after task | Sonnet | ~8 | only after a task, by dispatch | main idle cost |
| operator-dispatch | `operator-dispatch.md:285-311` | 80 s cycle (repo), 60 s (installed) | Opus | ~5 | repo: yes; installed: no | no idle interval |
| orchestrator-tick (Pattern X) | `orchestrator-tick.md:1262-1285` | 30 s, backoff to 1800 s on gate failure | operator session | many (1,300-line body) | no | not running; duplicates dispatch |
| dispatch-worker (Pattern Z) | `dispatch-worker.md:377-409` | 30 s / 5 s | sibling sessions | 4 to 6 | no | superseded by cli-hierarchy |
| `cli-orchestrator` shell loop | `pipeline-cli/src/orchestrator/loop.ts:152-160` | 30 s, backoff to 300 s | node, spawner only on work | 0 LLM | n/a | fine |
| `cli-dispatch-supervisor` | `pipeline-cli/src/dispatch/supervisor.ts:16,108` | setInterval + 30 min watchdog | node | 0 LLM | n/a | stale since 2026-09-19 |
| `auto-rearm-on-dequeue.yml` | cron every 5 min | 288 runs/day | shell + gh | 0 LLM | n/a | fine |
| LLM workflows (`ai-sdlc-review`, `isolated-review`, `untrusted-pr-gate`, `ai-sdlc-fix-ci`, triage, slack) | PR / issue events | event | API key | per event | n/a | not polling |

No Claude Code scheduled routines exist. local-trades runs no hierarchy loops; its cost is the `execute` loop sessions on Opus 4.8.

## 4. Prose automation audit

The plugin command bodies total 7,063 lines. About 4,100 are fixed procedures the model executes by reading prose (parse JSON, compare fields, move files, pick the next item, format a message), about 800 are deterministic CLI calls merely relayed, and about 700 need real reasoning. `execute.md` alone is 2,041 lines (142 KB, ~35k tokens loaded into every executor session) with ~1,300 convertible lines; `orchestrator-tick.md` is 1,323 lines with ~950. The `pipeline-cli/src/steps/00..13*.ts` code already implements the steps the prose re-narrates (for example `execute.md:648-705` hand-greps `pipeline.yaml` "mirroring the TS source of truth").

| Command | Lines | Convertible | Keep as LLM | Replacement |
|---|---|---|---|---|
| execute | 2,041 | ~1,300 | ~280 (dev, reviewers) | `ai-sdlc-pipeline next-step` state machine emitting JSON actions; body ≤ 250 lines |
| orchestrator-tick | 1,323 | ~950 | ~50 | retire behind cli-hierarchy, or one `tick` returning actions + next delay |
| execute-parallel, -status, -cleanup | 839 | ~670 | 0 | superseded by cli-hierarchy (RFC-0051); delete |
| dispatch-worker | 426 | ~250 | ~46 | retire behind cli-hierarchy |
| rebase, resolve-conflicts, fix-pr | 687 | ~290 | ~260 | `cli-pr-unstick` + rebase-prepare; script lockfile and prettier classes |
| executor | 308 | ~190 | ~8 | `cli-hierarchy executor-start` (identity, check-repo, check-sender, blocking claim) + `complete --notify` |
| operator-dispatch | 312 | ~130 | ~30 (routing only) | fold identity, handoff read, mark-ready-after-CodeQL, self-clear into `cli-hierarchy tick` |
| triage, cleanup, pipeline-status, review-pr | 445 | ~270 | ~30 | CLI call + Haiku formatter |

Model tiers: 22 of 23 commands and 5 agents (`review-executor`, `*-reviewer-codex`, `refinement-reviewer`, `rebase-resolver`, `ci-conflict-resolver`) are `model: inherit`, so a relay run from a Fable or Opus session pays Fable or Opus rates (the 2026-05-30 incident class). Recommended: `review-executor` and all relay commands on haiku; resolvers and refinement on sonnet; dispatch session on sonnet or haiku; developer sonnet; security-reviewer opus.

Governance living only in prose that can be code (no control removed): OQ-resolution marker scan in `check-rfc-docs.mjs`; scope-creep diff check (review task + new `backlog/tasks/` file); parent-on-main as a SessionStart hook and PreToolUse deny instead of a Step 0 prose call; CHANGELOG edit as a CI fail off the release branch; `check-sender` and `check-repo` inside the executor wrapper so they cannot be skipped; the "always 3 reviewers" rule enforced by the pr-ready rollup rather than a memory note. CLAUDE.md is 63 KB, about 80% procedure and design history; AISDLC-742 condenses it to ≤ 20 KB.

## 5. Decisions and tasks

Immediate (operator or dispatch, no code): take the ai-sdlc-io hierarchy down while its backlog is empty (`cli-hierarchy down` from that checkout); clear the idle ai-sdlc executors; cut a plugin release so sessions run AISDLC-741.

Tasks filed with this audit: AISDLC-759 (executor blocking claim + idle self-clear + executor-start wrapper), AISDLC-760 (dispatch idle hibernation and self-clear on every path), AISDLC-761 (plugin-wide model pinning, haiku for relays), AISDLC-762 (execute.md state-machine conversion), AISDLC-763 (retire orchestrator-tick, dispatch-worker, execute-parallel prose behind cli-hierarchy), AISDLC-764 (governance prose to hooks and CI checks), AISDLC-765 (usage audit CLI and weekly idle-cost digest). AISDLC-742 (CLAUDE.md condense) and AISDLC-738 (enqueue wakes an executor) are prerequisites already filed.

Decision for the operator: dispatch session model (Opus today). The tick is deterministic plus message relay; Sonnet is sufficient and Haiku plausible. Declined on 2026-10-06; re-raised with this data (the Opus dispatch idle loop alone was 40% of one day).
