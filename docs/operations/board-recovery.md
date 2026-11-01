# Dispatch board recovery

The dispatch board (`.ai-sdlc/dispatch/`) is gitignored runtime state. Its verdicts drive done/landed semantics and the closed-PR KPI. After the 2026-10-30 deletion ([incident](incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md)) nothing could restore it. Two paths now exist: a daily backup, and a rebuild from GitHub (AISDLC-1130).

## Daily backup

Each dispatch tick (`cli-hierarchy tick`) writes `~/.ai-sdlc/board-backups/<repo-id>/<YYYY-MM-DD>.tar.gz` at most once a day and keeps the newest seven. `<repo-id>` is the checkout directory name plus a short path hash. An empty board is never backed up, so a wiped board cannot replace a good copy. Run one by hand with:

```bash
node pipeline-cli/bin/cli-dispatch.mjs backup [--backup-dir <path>]
```

## Restore a backup (preferred)

Backups keep every verdict, brief and manifest exactly, so restore first:

```bash
ls ~/.ai-sdlc/board-backups/*/
node pipeline-cli/bin/cli-dispatch.mjs restore --backup <file> [--board-dir .ai-sdlc/dispatch]
```

`restore` refuses a board that already holds manifests or verdicts; `--force` extracts over it.

## Rebuild from GitHub (no backup)

```bash
node pipeline-cli/bin/cli-dispatch.mjs rebuild --from-github --dry-run   # print counts and items
node pipeline-cli/bin/cli-dispatch.mjs rebuild --from-github             # write them
```

One `gh pr list --state all` call reads every PR (the quota floor of AISDLC-963 is not at risk). A task id is taken from the PR title (`... (AISDLC-123)`). Classification:

| Source                                  | Board entry                                               |
| --------------------------------------- | --------------------------------------------------------- |
| Merged PR                               | `done/` success verdict with `landed` set                 |
| Open ready-for-review PR                | `failed/` verdict, cause `rebuilt-open-pr` (PR follow-up) |
| Open draft PR                           | `queue/` manifest                                         |
| Task in `backlog/completed/` with no PR | `done/` success verdict, no PR                            |
| Closed unmerged PR                      | ignored                                                   |

Every verdict carries `rebuilt: true`. Tasks already on the board in any state are left alone, so the command is safe to repeat. Executor-only detail (worker ids, timings, reviewer stamps, handoffs, open briefs) cannot be recovered this way; re-enqueue those by hand.

## Hint at startup

`cli-hierarchy up` prints the rebuild command when the board is empty but `backlog/completed/` is not. It never runs it.
