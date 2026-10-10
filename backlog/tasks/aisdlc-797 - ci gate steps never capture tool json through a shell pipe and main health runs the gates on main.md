---
id: AISDLC-797
title: >-
  CI gate steps never capture tool JSON through a shell pipe, and the main-health monitor exercises every gate script on main
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - stability
  - velocity
  - root-cause
dependencies: []
references:
  - .github/workflows/ci.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/main-health-monitor.yml
  - .github/workflows/__tests__/backlog-drift-report-file.test.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incident (2026-10-10, ~19:00-21:34 UTC).** The required `Backlog Drift` check failed on every open PR with `jq: parse error: Unfinished string at EOF`. The step captured the tool's JSON with `json="$(npx backlog-drift check --json ...)"`; the tool calls `process.exit(1)` on findings, Node does not flush pending pipe writes on exit, and the report crossed 64 KiB that afternoon, so the capture was cut mid-string. AISDLC-796 fixed that one step. The class is wider: any workflow step that captures a Node tool's stdout through command substitution and then parses it is one report-size growth away from the same failure, and when it fails it fails as a parse error that looks like a branch problem, so executors spent cycles "fixing" green branches.

**Root cause.** Two gaps: (1) no rule or test forbids the capture pattern in workflows; (2) nothing runs the gate scripts against `main` itself, so a gate that breaks for every branch is only discovered one PR at a time.

**Fix.**
1. Add a hermetic workflow test (`.github/workflows/__tests__/no-json-capture.test.mjs`) that scans every `.github/workflows/*.yml` `run:` block and fails on `=$(` or `="$(` captures whose command is a `node`, `npx`, `pnpm` or `cli-*.mjs` invocation with a `--json` or `--format json` flag, or whose result is piped to `jq`. The accepted pattern is a redirect to `"$RUNNER_TEMP/<name>.json"` followed by a validity check (`jq -e 'type == "array" or type == "object"'`) with an `::error::` naming the file and the exit code. Convert every current offender; list them in the PR body.
2. The main-health monitor gains a `gate-scripts` job that runs, on `main`, the same gate steps PRs run (backlog drift, docs-only classifier, DoR violations, dark-code, patch-id exclusions parity) and opens the `[main-health]` issue when one fails, so a gate that is broken for everyone pages within minutes of the merge that broke it.
3. The drift report size is a leading indicator: the drift step prints the report byte size and warning count, and `ai-sdlc doctor` warns when warnings exceed 150 so the backlog is cleaned before the report grows.

**Velocity impact.** Positive. One class of all-PRs-red outage removed; no new gate on developers, only on workflow authors, and the test runs in the existing `pnpm test` chain.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] A hermetic test fails on any workflow `run:` step that captures a Node/npx/pnpm tool's JSON output via command substitution or pipes it into `jq`; all current offenders are converted to the file-redirect pattern.
- [ ] `main-health-monitor.yml` runs the gate scripts on `main` after every push and opens the `[main-health]` issue when any fails; a hermetic workflow test covers the job wiring.
- [ ] The Backlog Drift step prints report size and warning count; `ai-sdlc doctor` warns above 150 warnings.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 1 of the 2026-10-10 pipeline-stability root-cause set (AISDLC-797..803). Incident fix: AISDLC-796 (#1342).
