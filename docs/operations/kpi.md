# KPIs

Shared KPI page. Sections are refreshed by CLI commands; do not hand-edit the marked blocks.

## PRs closed unmerged (waste)

Every PR that ends closed instead of merged carried a filing, CI runs and operator attention that produced nothing. **The target is zero.** Metric `prs-closed-unmerged` (AISDLC-831) is emitted by `cli-quality-corpus aggregate` (7-day window; one `gh pr list --state all` call per run) with the total, per-cause counts, the per-ISO-week counts, and the PR numbers and task ids listed. Cause: `re-filed` (a later open or merged PR names the same task id), `superseded` or `withdrawn` (label or title says so), else `unknown`. The dispatch tick carries `closedUnmerged: <n>` in its result and progress line for the current drain window, from the same classifier (`pipeline-cli/src/kpi/closed-unmerged.ts`). A re-file is visible the same day: name the avoidable cause and file the fix at once.

## PR throughput

Command: `node pipeline-cli/bin/cli-kpi.mjs pr-throughput [--since <date>] [--days N] [--json] [--no-write]` (AISDLC-877). One `gh pr list --state all` call, cached per UTC day in `.ai-sdlc/kpi/` (reruns inside a day make no API call). No model calls. Refresh is a manual run; it is not wired into `main-health-monitor.yml` because a daily page-refresh commit does not fit the record-PR fast lane. The command prints one summary line suitable for the operator digest.

### Metric definitions

- **Class** (by head branch): task (`ai-sdlc/aisdlc-N*`), record (`ai-sdlc/file-*`, `ai-sdlc/decisions-sync*`, `chore/sync-tasks*`, `release-please--*`, `rfc-*`, `audit-*`), dependency (`dependabot/*`), other.
- **Opened**: PRs created that UTC day. **Landed**: PRs merged that UTC day. **Closed unmerged**: PRs closed without merge that UTC day.
- **Ratio**: landed / opened, for all PRs and for task PRs only. Record PRs are about 58% of volume, so the task ratio is the signal.
- **Task latency**: open-to-land time (hours) for task PRs landed that day; median, p90 (nearest rank) and max.

### Backlog growing signal

A landed/opened ratio below 1.0 for two consecutive days means PR production is outpacing merges: the backlog is growing.

<!-- pr-throughput:begin -->
Run the command to populate this table.
<!-- pr-throughput:end -->
