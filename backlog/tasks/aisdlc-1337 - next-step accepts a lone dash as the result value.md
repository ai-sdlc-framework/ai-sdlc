---
id: AISDLC-1337
title: 'The next-step command accepts a lone dash as the result value'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - pipeline-cli
  - adopter
dependencies: []
references:
  - pipeline-cli/src/cli/index.ts
  - pipeline-cli/src/cli/next-step.ts
  - pipeline-cli/src/cli/next-step.test.ts
  - pipeline-cli/src/cli/index.test.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one argument rewrite in the CLI entry and its tests.'
---

## Description

**Gap.** `next-step --result -` is meant to read the result from standard input, and an empty input re-emits the pending instruction. The command text in `ai-sdlc-plugin/commands/execute.md` tells the session to run exactly that with `</dev/null`. Today the parser rejects the lone dash as a stray argument, prints the usage text and `Unknown argument: -`, and re-emits nothing. `--result=-` and omitting `--result` both work.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18 and 2026-11-19): `ai-sdlc-pipeline next-step ... --result -` with standard input from `/dev/null` printed the usage text and `Unknown argument: -` instead of the pending instruction.

**Cause (read from the source).**

- `pipeline-cli/src/cli/next-step.ts:91-96` declares `--result` as a string and documents `'-'` for standard input; `next-step.ts:109-114` reads standard input when the value is `-`. The handler is right; the value never arrives.
- `pipeline-cli/src/cli/index.ts:117` builds the parser from `hideBin(process.argv)` and `index.ts:1119` turns on `.strict()`. The argument parser treats a bare `-` as a positional, so `--result -` leaves `--result` without a value and `-` as an unknown argument. Run against `main`, `--result -` fails and `--result=-` passes.
- The `reply` text built in `pipeline-cli/src/next-step/` ends with `--result -` (asserted at `pipeline-cli/src/next-step/next-step.test.ts:278`), and `execute.md:84` tells the session to replace that tail with a file path, so the dash form is the documented one.

**Shape.** `--result -` behaves exactly like `--result=-`: the result is read from standard input, and an empty input re-emits the pending instruction. No other option changes.

**Control.** No control changes.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the documented command form must work as written; no reason to change the text every session already follows. 2. Deleted: nothing to delete; the reply text and the command text stay as they are. 3. Simplified or optimised: one small argument rewrite before parsing, limited to `--result` followed by a lone dash. 4. Accelerated: a re-emit no longer needs a retry after a usage error. 5. Automated: a test runs the parser with the dash form so it cannot regress.

- **Rewrite.** Before the parser runs, turn the pair `--result` and `-` into the single token `--result=-`. Leave every other argument untouched.
- **Tests.** Add parser tests for `--result -` (value `-`), `--result=-`, and `--result <file>` unchanged; add a next-step test that an empty standard input with the dash form re-emits the pending instruction.

Out of scope: changing the `reply` text, other options that might take a dash, and the command text in `execute.md`.

## Acceptance Criteria

- [ ] #1 A test parses `next-step --task AISDLC-1 --state s.json --result -` and gets `result` equal to `-` with no `Unknown argument` error.
- [ ] #2 A test parses `--result=-` and `--result <file>` and gets the same values as before.
- [ ] #3 A test runs the handler with the dash form and an empty standard input and gets the pending instruction, not a usage error.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
