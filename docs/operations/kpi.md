# KPIs

Shared KPI page. Sections are refreshed by CLI commands; do not hand-edit the marked blocks.

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
