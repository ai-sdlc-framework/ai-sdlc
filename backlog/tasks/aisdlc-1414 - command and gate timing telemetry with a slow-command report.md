---
id: AISDLC-1414
title: 'Command and gate timing telemetry with a slow-command report'
status: In Progress
assignee: []
created_date: '2026-11-25'
labels:
  - observability
  - pipeline-cli
  - pre-push
dependencies: []
references:
  - .husky/pre-push
  - pipeline-cli/bin
  - pipeline-cli/src/cli/hierarchy.ts
priority: high
---

## Description

**Five-step review (requirements first).** The requirement, from the operator on 2026-11-25: we need telemetry on how long commands take, so we notice why a command is slow and can fix it. A command that waits 10 minutes is not acceptable.

On 2026-11-25 a `cli-file task --pr` run hung for over 10 minutes. Nothing recorded where the time went. The investigation first blamed a stuck verify slot (AISDLC-1413) after inspecting processes and slot files by hand; the likelier cause, found later, was `cli-file`'s deliberate 15-minute spacing between filing PRs, which printed one line that a caller showing only the tail of the output never saw. Two later filings that day each waited 898 seconds for the same reason. That spacing has since been deleted (AISDLC-1437, DEC-0432 b), so no filing-spacing wait remains to time. Today no record says how long a pipeline-cli command, a pre-push gate or a slot wait took.

- **Delete:** no new service or dashboard. One local append-only file and one report command.
- **Simplify:** one record shape for every timed span: a command, a pre-push gate, a wait.
- **Accelerate:** slow spans surface in the session that runs them and in `cli-hierarchy status`, not only in a later report.
- **Automate:** recording is automatic for every pipeline-cli bin and every pre-push gate; nobody has to opt in per command.

## Fix

- Append one JSON line per span to `.ai-sdlc/dispatch/timings.jsonl`: `{ at, kind: command|gate|wait, name, args (redacted: no tokens, no file contents), durationMs, exitCode, pid, session or role when known, taskId when known, waitedOn (for waits: what and who) }`. Rotate the file at a size limit.
- Wrap every `pipeline-cli/bin/cli-*.mjs` entry point once, at a shared entry, so a new bin is timed without extra code.
- Time each step of `.husky/pre-push` and record it as a `gate` span, including steps that exit early.
- Record every verify-slot wait as a `wait` span with the holder named (AISDLC-1413 supplies the holder identity).
- While a command runs past a threshold (default 60 seconds), print one line to stderr naming the span it is in and the elapsed time, and repeat every 60 seconds.
- `cli-hierarchy timings [--since <dur>] [--slow <ms>]`: p50, p95 and max per command and per gate, plus the slowest individual spans.
- `cli-hierarchy status`: one line for any span over the threshold in the last hour.

## Acceptance Criteria

- [ ] #1 Every `pipeline-cli/bin/cli-*.mjs` command appends one `command` span with duration and exit code, including on failure and on SIGINT.
- [ ] #2 Each `.husky/pre-push` step appends one `gate` span.
- [ ] #3 Each verify-slot wait appends one `wait` span naming what it waited on.
- [ ] #4 A command running past the threshold prints the current span and elapsed time to stderr, then repeats every 60 seconds.
- [ ] #5 `cli-hierarchy timings` reports p50, p95 and max per command and per gate, and lists the slowest spans.
- [ ] #6 `cli-hierarchy status` shows spans over the threshold in the last hour.
- [ ] #7 No span records a token, credential or file contents; a test asserts the redaction.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
