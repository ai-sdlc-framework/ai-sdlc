---
id: AISDLC-877
title: 'feat(kpi): PR throughput KPI - opened vs merged per day (task/record split), merge latency, and the merge-to-production ratio'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [kpi, velocity, rfc-0054]
dependencies: []
references:
  - pipeline-cli/bin/cli-decisions.mjs
  - pipeline-cli/bin/cli-quality-corpus.mjs
  - .github/workflows/main-health-monitor.yml
  - docs/operations/main-health-monitor.md
priority: high
dispatchable: true
---

## Context

Source: drain review 2026-10-13/14 (planner + operator ruling 2026-10-14). Operator goal: "PR merge rate must stay >= PR production rate, else the backlog grows." The drain review measured, over 4 days (10-11..10-14): task PRs 59 opened / 52 landed (ratio 0.88), record PRs 84 opened / 77 landed; task PR open-to-land latency median 4h, p90 21h, max 67h. 58% of PR volume is record PRs (`file-*`, decisions-sync, sync-tasks, release-please), so an all-PR number hides the task signal.

No task owns this metric. AISDLC-831 owns only the closed-unmerged KPI; this task extends the same KPI page under `docs/operations/` with a "PR throughput" section rather than adding a second page. Design context is the PR lifecycle event-driven dispatch RFC (Draft; `assumes:` its terminal states and its KPI note on closed-unmerged, not `requires:`). The RFC number is deliberately not written here: the DoR upstream-OQ gate blocks any task that names a Draft RFC by number.

## Fix

**Five-step review (requirements first).** Requirement questioned: "we need a dashboard UI for throughput". No: a CLI table plus one docs page answers the operator's question; the web dashboard RFC comes post-drain. Delete: nothing, there is no existing throughput metric code. Simplify: classify PRs by branch name only, no LLM, no new dependency. Accelerate: one paginated `gh pr list --state all` call, cached as JSON in `.ai-sdlc/kpi/`. Automate (last): `main-health-monitor.yml` runs the command daily and commits the page refresh ONLY if that fits the existing record-PR fast lane (AISDLC-867); otherwise leave a manual run and state so in the docs.

1. Add `pipeline-cli/bin/cli-kpi.mjs pr-throughput [--since <date>] [--days N] [--json]` (source under `pipeline-cli/src/kpi/`). Reads `gh pr list --state all` (or the GitHub API) and classifies each PR by head branch: task (`ai-sdlc/aisdlc-N*`), record (`ai-sdlc/file-*`, `ai-sdlc/decisions-sync`, `chore/sync-tasks*`, `release-please--*`, `rfc-*`, `audit-*`), dependency (dependabot), other.
2. Per UTC day emit: opened, landed, closed-unmerged, ratio landed/opened (all PRs and task-only), and open-to-land latency median/p90/max for task PRs.
3. Write or refresh a "PR throughput" table in the shared KPI page under `docs/operations/` (one page), and print one summary line for `cli-decisions operator-digest`.
4. Cache the fetched list in `.ai-sdlc/kpi/` so reruns inside a day make no API call.

## Acceptance Criteria

- [x] #1 The command exists with Vitest tests on fixture PR lists covering all four classes (task, record, dependency, other) and the ratio and latency math
- [x] #2 Output on a recorded fixture matches the 10-11..10-14 numbers above (task 59/52, record 84/77, median 4h, p90 21h, max 67h) within +-1
- [x] #3 The KPI page has a "PR throughput" section refreshed by the command, and the digest receives one summary line
- [x] #4 The docs/operations page documents the metric definitions and states that a landed/opened ratio below 1.0 for two consecutive days is the "backlog growing" signal
- [x] #5 No model calls and no new dependencies
- [x] #6 The dark-code gate passes (the command has a non-test importer: the CLI bin)

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm dark-code:check && pnpm lint && pnpm format:check`

## Out of scope

- A web dashboard or any UI.
- Acting on the signal (pausing filing, rebalancing the queue); this task only measures.
- The closed-unmerged counter itself (AISDLC-831); this task only reports the per-day count from the same list.

**Velocity impact.** Positive by visibility; one API call per day, zero tokens. Estimated size: M.
