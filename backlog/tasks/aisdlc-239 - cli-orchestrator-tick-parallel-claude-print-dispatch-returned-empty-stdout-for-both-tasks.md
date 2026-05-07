---
id: AISDLC-239
title: >-
  Orchestrator spawner swallows stderr + exit-code on subprocess failure —
  diagnose-then-fix the empty-stdout case requires full instrumentation first
status: To Do
assignee: []
created_date: '2026-05-07 22:35'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - framework-bug
  - dogfood
dependencies: []
priority: high
references:
  - pipeline-cli/src/orchestrator/loop.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Running `cli-orchestrator tick --max-concurrent 2` to dispatch 2 tasks in parallel resulted in BOTH dispatches failing with `developer-json-contract-violated` and the same error pattern:

```
notes: developer subagent violated JSON envelope contract on both turns.
       initial (failed to parse developer JSON: Unexpected end of JSON input (raw output: ""));
       retry (failed to parse developer JSON: Unexpected end of JSON input (raw output: ""))
```

Both `claude --print --agent developer` subprocesses returned EMPTY stdout. The AISDLC-176 retry path fired and got empty again. AISDLC-229's umbrella correctly recorded the failure outcome and tick continued cleanly.

## What ISN'T the cause

Verified by direct test 2026-05-07:

```bash
echo "say 'subscription works'" | claude --print --output-format json
# returned: {"type":"result","subtype":"success","is_error":false,"result":"subscription works", ...}
# cost $0.11, used Opus 4.7, subscription auth confirmed
```

So:
- ✗ Not subscription auth (works in single-process invocation)
- ✗ Not subscription quota (single-process worked, parallel both failed)
- ✗ Not API key (operator's API credits are intentionally zero; orchestrator path uses subscription)

## Real problem: the orchestrator is swallowing diagnostic data

The current outcome envelope is unhelpful:

```
notes: developer subagent violated JSON envelope contract on both turns.
       initial (failed to parse developer JSON: Unexpected end of JSON input (raw output: ""));
       retry (failed to parse developer JSON: Unexpected end of JSON input (raw output: ""))
```

We get `raw output: ""` — that's the parsed STDOUT after JSON parse failed. But we have NO information about:

- `claude --print` exit code (0? 1? 254? signal-killed?)
- Subprocess STDERR (claude prints errors to stderr by default)
- Subprocess wall-clock duration (did it die immediately or hang then die?)
- Whether the subprocess was killed by the spawner's watchdog (`feedback_dev_subagent_watchdog.md`: 600s silent-stdout watchdog) — kill via signal would be relevant
- The exact argv passed to claude (so we can reproduce by hand)

Without those, "subscription quota / template bug / race condition" is all guesswork. The fix has to start with INSTRUMENTING the spawner to capture and surface these signals in the outcome envelope. THEN we know what the bug is.

## Acceptance Criteria

- [ ] #1 `pipeline-cli/src/orchestrator/spawner/shell-claude-p.ts` (or wherever ShellClaudePSpawner lives) captures stderr to a buffer + reads exit code via `child_process.exec`'s `code`/`signal` callback args
- [ ] #2 The outcome envelope's `notes` field (or a new structured `subprocessDiagnostics` field) includes: `exitCode`, `signal` (if killed), `stderrTail` (last 2 KB of stderr), `wallClockMs`, full `argv` array
- [ ] #3 If exit code is non-zero AND stderr contains an Anthropic error pattern (`api_error_status`, `invalid_request_error`, `rate_limit`, etc.), tag the failure type as `claude-cli-api-error` instead of generic `developer-json-contract-violated`
- [ ] #4 If exit code is 0 but stdout is empty AND wall-clock < 5s, tag as `claude-cli-empty-output-fast` (likely auth/config issue, not actual subagent execution)
- [ ] #5 If killed by signal AND signal is `SIGKILL`/`SIGTERM`, tag as `claude-cli-killed` and include the watchdog-fired flag if applicable
- [ ] #6 Re-run the original repro (`cli-orchestrator tick --max-concurrent 2` on AISDLC-178.7 + AISDLC-202.2 or similar pair) with the new instrumentation — capture and document the actual error class
- [ ] #7 Fix the root cause once identified — but ONLY after the diagnostics are in place. No speculative fix.
- [ ] #8 Hermetic test: spawner's diagnostic capture works for: (a) exit-0-with-output, (b) exit-1-with-stderr, (c) signal-killed, (d) timeout-watchdog-killed

## Composes with

- **AISDLC-229** (orchestrator umbrella wiring) — exposed this bug because parallel was previously not exercised end-to-end
- **AISDLC-228 / AISDLC-227** (parallel safety + in-flight detection) — partial overlap; this one is about claude --print itself, those are about orchestrator coordination

## References

- `pipeline-cli/src/orchestrator/loop.ts` (orchestrator dispatch path)
- `pipeline-cli/src/orchestrator/spawner/` (ShellClaudePSpawner implementation)
- AISDLC-229 (umbrella wiring — landed the path that exposed this)
- AISDLC-176 (retry-on-contract-violation — fired and also returned empty)
- Witnessed dogfood incident 2026-05-07: `cli-orchestrator tick --max-concurrent 2` → both AISDLC-178.7 + AISDLC-202.2 returned `developer-json-contract-violated` with empty raw output
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Spawner captures stderr + exit code + signal + wall-clock-ms + argv
- [ ] #2 Outcome envelope surfaces structured `subprocessDiagnostics` (or expanded `notes`) with all of the above
- [ ] #3 Failure-type taxonomy expanded to distinguish: claude-cli-api-error, claude-cli-empty-output-fast, claude-cli-killed-by-watchdog, vs the generic developer-json-contract-violated
- [ ] #4 Re-run the original repro with new instrumentation — document the actual error class observed
- [ ] #5 Fix the root cause AFTER diagnostics surface it (no speculative fix)
- [ ] #6 Hermetic test: diagnostic capture works for exit-0-with-output, exit-1-with-stderr, signal-killed, timeout-watchdog-killed
- [ ] #7 Operator runbook documents the new diagnostic fields + how to read them
<!-- SECTION:ACCEPTANCE:END -->
