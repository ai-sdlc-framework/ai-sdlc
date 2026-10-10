---
id: AISDLC-796
title: >-
  Backlog Drift CI job reads the JSON report from a file, not a 64 KiB-truncated command substitution, so it stops failing every PR with a jq parse error
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - unblocker
  - backlog
dependencies: []
references:
  - .github/workflows/ci.yml
  - .github/workflows/ai-sdlc-gate.yml
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since about 19:00 UTC on 2026-10-10 the required `Backlog Drift` check fails on nearly every open PR (#1243, #1292, #1303, #1306, #1315 and more) with `jq: parse error: Unfinished string at EOF at line 1528, column 41`. The job's step captures the report with `json="$(npx backlog-drift@0.1.3 check --json 2>/dev/null || true)"`. The tool exits 1 when it finds issues; Node's `process.exit` does not wait for pending writes to a pipe, so once the pretty-printed JSON passes the 64 KiB pipe buffer the captured text is cut mid-string. The report crossed that size this afternoon (190 drift issues on main, about 1,170 lines / 48 KB on main and more on branches with extra tasks), which is why the failure appeared everywhere at once. Running the same command with stdout redirected to a file produces complete, valid JSON (146-element array locally) and exits 1 as designed.

Fix the step in `.github/workflows/ci.yml` and in the copy that AISDLC-727 (#1313) adds to `.github/workflows/ai-sdlc-gate.yml` (whichever lands second must carry the same fix): run `npx backlog-drift@0.1.3 check --json > "$RUNNER_TEMP/backlog-drift.json" 2>/dev/null || true`, feed jq that file, and fail with a clear `::error::` naming the file when it is not valid JSON instead of letting jq's parse error stand as the gate verdict. Keep the human-readable second run and the error-severity-only gate exactly as they are. Add a workflow test under `.github/workflows/__tests__/` asserting the step redirects to a file and never uses command substitution for the JSON.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] The Backlog Drift step writes the JSON report to a file under `$RUNNER_TEMP` and reads it from there; no `$(...)` capture of the JSON remains in either workflow.
- [ ] Invalid JSON in that file fails the step with an `::error::` that names the file and the tool exit code, not a jq parse error.
- [ ] A hermetic workflow test fails if the capture is reintroduced.
- [ ] After the change, a PR whose only red check was `Backlog Drift` with the jq parse error goes green on re-run with no other change.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Unblocker: every open PR is red on this check until it lands; dispatch resumes drift-only reds by re-running CI, not by executor work. Related: AISDLC-727 (#1313) moves the job into the gate workflow.
