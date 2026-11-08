# Hierarchy walkthrough: shot list

A screenshare of the typical workflow: planner, dispatch brief, executor claims, three reviewers, verdict, merge. Target length: **12 minutes, hard cap 15**. Spawner: the **real spawner** (`cli-hierarchy spawn`, one ephemeral Claude Code session per task). There is no mock spawner; the demo stays short because each of the three tasks is a 10 to 30 line function that passes review on the first round.

## North-star features shown

1. **Session hierarchy** (`cli-hierarchy`, RFC-0051): planner, dispatch and ephemeral executors in tmux. See [`cli-hierarchy.md`](../operations/cli-hierarchy.md).
2. **Operator TUI** (`pipeline-cli/bin/cli-tui.mjs`, RFC-0023): live board of tasks, PRs and sessions.
3. **Context-meter mod** (AISDLC-743): the planner status line shows context use with compact, clear and hand-off actions. See [`context-meter.md`](../operations/context-meter.md).

## Setup (off camera)

```bash
scripts/demo/seed-demo-repo.sh ~/ai-sdlc-demo
cd ~/ai-sdlc-demo
bash <repo>/scripts/demo/tmux-layout.sh demo   # panes: planner | dispatch | TUI | shell
```

Seeded tasks: `DEMO-1` slugify, `DEMO-2` clamp, `DEMO-3` chunk. Reset between takes with `scripts/demo/reset-demo-repo.sh`.

## Shot list

| #   | Time  | Pane     | Command                                                                  | Viewer should see                                                        |
| --- | ----- | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | 0:00  | shell    | `node pipeline-cli/bin/cli-hierarchy.mjs up`                             | planner and dispatch sessions start, roster printed                      |
| 2   | 0:45  | shell    | `node pipeline-cli/bin/cli-hierarchy.mjs status`                         | roster with live state                                                   |
| 3   | 1:15  | TUI      | `node pipeline-cli/bin/cli-tui.mjs`             | board with three To Do tasks                                             |
| 4   | 2:00  | planner  | `/ai-sdlc planner`                                                       | planner reads the board; context meter visible in the status line        |
| 5   | 3:00  | shell    | `node pipeline-cli/bin/cli-hierarchy.mjs brief`                          | dispatch brief: one wave, three independent tasks                        |
| 6   | 4:00  | dispatch | `/ai-sdlc operator-dispatch`                                             | dispatch spawns one executor per task                                    |
| 7   | 4:30  | shell    | `node pipeline-cli/bin/cli-hierarchy.mjs status`                         | three executors claimed, inflight tasks listed                           |
| 8   | 5:00  | TUI      | (watch)                                                                  | tasks move To Do, In Progress, PR open                                   |
| 9   | 8:00  | TUI      | (watch)                                                                  | three reviewer verdicts per PR, all pass on round one                    |
| 10  | 10:00 | dispatch | `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog` | PRs merge once checks are green and clean                          |
| 11  | 11:00 | planner  | (watch)                                                                  | context meter after the run                                              |
| 12  | 11:30 | shell    | `node pipeline-cli/bin/cli-hierarchy.mjs down`                           | sessions stop, board shows three Done                                    |

## Dry-run checklist

- [ ] Land first: AISDLC-759, AISDLC-760, AISDLC-766 (idle and self-clear), AISDLC-743 (context meter), AISDLC-671 (RFC-0051 results note).
- [ ] `scripts/demo/seed-demo-repo.sh` run twice prints the same commit SHA.
- [ ] `tmux`, `claude` and `gh` installed and authenticated; subscription billing, no `ANTHROPIC_API_KEY`.
- [ ] Terminal 220x55, font size readable at 1080p; notifications off.
- [ ] A full dry run finishes in under 15 minutes wall-clock; note the time.
- [ ] Demo repo has a GitHub remote the executors can open PRs against.
- [ ] After the take: `node pipeline-cli/bin/cli-hierarchy.mjs down`, then `scripts/demo/reset-demo-repo.sh`.
