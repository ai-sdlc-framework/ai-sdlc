---
id: AISDLC-963
title: 'Every gh call from the hierarchy is logged with its session and remaining quota, and status reports calls per hour per session'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - observability
  - cost
dependencies: []
references:
  - pipeline-cli/src/runtime/exec.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/up.ts
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

The user-token quota (5,000 per hour) was exhausted on two consecutive days and nothing on the machine could say which session or command spent it: there is no wrapper, counter or log for `gh`, the hierarchy runner in `runtime/exec.ts` logs nothing, and several callers (decisions persistence, cli-file, the MCP server tools, the orchestrator package) spawn `gh` directly. The audit that found the heavy hitters had to be done by reading code.

**Five-step review (requirements first).**
1. Requirement questioned: do we need a GitHub-side dashboard? No; a local append-only log of every call with the caller and the `x-ratelimit-remaining` header answers every question asked so far.
2. Delete: nothing to delete.
3. Simplify: the runner in `exec.ts` appends one JSON line per `gh` invocation (timestamp, `HIERARCHY_SESSION`, argv, exit status, remaining quota parsed from `gh api -i` when present) to `<board>/gh-calls.jsonl`; `cli-hierarchy up` puts a tiny `gh` shim first on each session PATH that does the same for callers that bypass the runner, then execs the real binary.
4. Accelerate: `cli-hierarchy status` prints calls in the last hour per session and the live remaining for core and graphql; the dispatch tick refuses GitHub work (and says so) when remaining is below a floor (default 300) instead of failing mid-pipeline. The gate workflow prints the Actions bucket remaining at the start and end of every run in the job summary.
5. Automate: a test asserts a runner call writes one line; a log rotation keeps 24 hours.

## Acceptance Criteria

- [ ] `<board>/gh-calls.jsonl` records every gh call from hierarchy sessions, including those spawned outside the runner.
- [ ] `cli-hierarchy status` shows per-session calls per hour and live remaining quota.
- [ ] The dispatch tick skips GitHub reads below the floor and logs the skip.
- [ ] The gate job summary shows the Actions quota remaining before and after each run.
