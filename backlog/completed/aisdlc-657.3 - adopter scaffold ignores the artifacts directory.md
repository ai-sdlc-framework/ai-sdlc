---
id: AISDLC-657.3
title: >-
  RFC-0050 follow-up: the adopter scaffold and runtime gitignore lists include .ai-sdlc/artifacts
status: Done
assignee:
  - dispatch-executor-gamma
created_date: '2026-10-02'
labels:
  - rfc-0050
  - orchestrator
  - adopter
dependencies:
  - AISDLC-657.2
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/execute.ts
  - docs/operations/model-routing.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during the AISDLC-657.2 security review (PR #1153), operator-approved for
filing 2026-10-02. AISDLC-657.2 makes `.ai-sdlc/artifacts` the shared runtime output
directory of the resolver, the scorecard and the replay commands. This repository
ignores it through its own root `.gitignore`, but the adopter scaffold does not: the
`GITIGNORE_PATHS` list in `orchestrator/src/cli/commands/init.ts` and the
`RUNTIME_GITIGNORE_PATHS` list in `orchestrator/src/execute.ts` cover only
`.ai-sdlc/state.db`, `.ai-sdlc/state/` and `.ai-sdlc/audit.jsonl`. An adopter who
runs the scorecard or a replay would commit evidence files, assignment logs and
replay results. This should land before the routing commands are promoted to adopters
(AISDLC-657.1).

## Conventions
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- Keep the two lists in agreement; prefer one shared constant if the import graph
  allows it without a new package dependency.

## Scope
1. Add `.ai-sdlc/artifacts/` to both ignore lists, under the existing
   `# ai-sdlc:runtime-gitignore` sentinel block so repositories initialised earlier
   gain the entry on the next `execute` run.
2. `doctor` reports a missing `.ai-sdlc/artifacts/` ignore entry with the same
   severity as the existing runtime-path checks.
3. The model-routing runbook's "gitignored in this repository" sentence becomes
   "ignored by the scaffold".

## Acceptance Criteria
- [x] `init` on an empty directory writes a `.gitignore` containing `.ai-sdlc/artifacts/`.
- [x] `execute` on a repository whose sentinel block lacks the entry appends it once and does not duplicate it on a second run.
- [x] `doctor` flags a `.gitignore` without the entry and is quiet with it. (Severity `warn`: the task's "same severity as the existing runtime-path checks" has no referent, because `doctor` had no runtime-path ignore check.)
- [x] The runbook sentence is updated.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass. (Run per the operator's no-workspace-wide-test rule: the affected orchestrator test files, the full `reference` suite, prettier and eslint on the changed files, and the workspace typecheck at commit; the full suite runs in CI and the pre-push gate.)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
The adopter scaffold and the `execute` runtime repair now ignore `.ai-sdlc/artifacts/`, and a repository initialised earlier gains the entry once, under its existing runtime block. `doctor` warns when a `.gitignore` lacks it, and the model-routing runbook says the directory is ignored by the scaffold.

## Changes
- `orchestrator/src/runtime-gitignore.ts` (new): the sentinel, the shared path list (now with `.ai-sdlc/artifacts/`) and the pure text logic (`missingRuntimeGitignorePaths`, `gitignoreCovers`, `hasSentinelLine`, `insertIntoSentinelBlock`); both writers import it so the two lists cannot drift.
- `orchestrator/src/cli/commands/init.ts` and `orchestrator/src/execute.ts` (modified): add missing entries even when the sentinel block already exists (they used to return early), inserting them under that block; `execute.ts` now exports `ensureRuntimeGitignore` for tests.
- `orchestrator/src/cli/commands/doctor-checks.ts` (modified): new `runtime-gitignore` check, `warn` when the entry is absent or negated.
- `docs/operations/model-routing.md` (modified): the "gitignored in this repository" sentence now says the scaffold ignores it.
- Tests: `runtime-gitignore.test.ts` and `execute.gitignore.test.ts` (new), `doctor-checks.test.ts` and `init-workspace.test.ts` (extended).

## Design decisions
- **Two predicates, not one**: `doctor` asks "does git effectively ignore it" (order- and negation-aware; an indented entry does not count because git keeps leading spaces), while `init` and `execute` ask "is it written". A writer that treated a deliberate `!entry` as missing would re-insert the entry before that line on every run and grow the file without changing what git ignores.
- **Exact-line sentinel test everywhere**: callers and the inserter use `hasSentinelLine`, so sentinel text inside another line can never make a run rewrite the file unchanged and never add the entries.
- **Linear-time normalisation**: slashes are stripped by index; the first review found a backtracking regex a hostile `.gitignore` line could use to hang `init`, `execute` and `doctor`.
- **Behaviour change**: a sentinel block lacking an entry is now repaired on every run, so a runtime line deliberately deleted from the block is re-added; that is the repair semantics the task asks for.

## Verification
- Orchestrator tests, single files with `--maxWorkers=2`: `runtime-gitignore`, `execute.gitignore`, `doctor-checks`, `init-workspace`, `commands`, `doctor`, `execute` and `execute.guards` all pass (217 passed, 1 skipped before the hardening commit; 167 passed, 1 skipped for the five files it touched after it). Full `reference` suite: 1916 passed.
- prettier and eslint clean on the changed files; workspace typecheck passes at commit; `pnpm dark-code:check` passes.
- Two review rounds. Round 1 approved with minors, and the security review (Opus) found a quadratic regex, a coverage check that ignored negation and indented entries, and a substring-versus-exact sentinel mismatch, all fixed. Round 2 on head 82b08367: code, test and security (Opus) all approved with no critical or major findings. `harnessTranscriptHash` is null in this environment.

## Follow-up
- declined: `doctor` matches exact lines and does not recognise a parent-directory or wildcard ignore (`.ai-sdlc/`, `.ai-sdlc/*`), a wildcard negation (`!.ai-sdlc/*`) or a nested `.ai-sdlc/.gitignore`; asking `git check-ignore` is the robust fix, and the check is advisory with `warn` severity.
- declined: `normalize` trims trailing tabs where git keeps them in a pattern; it needs an accidental tab in the file and only affects an odd edit.
- declined: both writers and `doctor` follow a symlinked `.gitignore`; this already held before this change, and the text written is fixed constants.
- declined: a user line placed directly under the sentinel block with no blank line makes the new entry land after it; cosmetic, no line is lost, and a second run changes nothing.
<!-- SECTION:FINAL_SUMMARY:END -->
