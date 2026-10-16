---
id: AISDLC-913
title: 'fix: cli-dispatch pr-facts builds the classify-prs input itself, with a real mergeStateStatus and the failing line, so the tick stops hand-assembling REST payloads'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [bug, pipeline-cli, dispatch, hierarchy]
dependencies: []
references: [pipeline-cli/src/hierarchy/pr-state.ts, pipeline-cli/src/cli/dispatch.ts, pipeline-cli/src/cli/dispatch.test.ts, ai-sdlc-plugin/commands/operator-dispatch.md, docs/operations/cli-hierarchy.md]
priority: high
dispatchable: true
---

## Description

Reported by the dispatch session on 2026-10-14, two ticks in a row. The dispatch command (`ai-sdlc-plugin/commands/operator-dispatch.md`) asks the session to assemble `.pr-facts.json` by hand from the REST pull list plus check-runs, then run `cli-dispatch classify-prs`. Two fields the classifier depends on never arrive: (1) `mergeStateStatus` comes back `unknown` for every PR, because the REST list resource does not carry it (only the single-PR resource has `mergeable_state`, lower-case and with different values), so `behind-or-dirty` and `armed-clean` are blind; (2) `failingLine` is empty on every `real-failure`, because `classifyPr` in `pipeline-cli/src/hierarchy/pr-state.ts` takes it from the `ai-sdlc/pr-ready` check-run `output.title`, which is blank; the actual failing line lives in the job log. Each tick therefore spends model turns re-fetching per PR and still produces resume notes without a failing line.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the session gathers PR facts in prose at all. The automation ladder puts deterministic gathering first; nothing here needs a model. 2. Deleted: the hand-assembly instructions in the dispatch command and the `--input` requirement on `classify-prs` (kept as an optional override for tests). 3. Simplified: one subcommand `cli-dispatch pr-facts --board-dir <dir>` that, for every open task PR in the roster, reads the single-PR resource, maps `mergeable_state` to the GraphQL vocabulary (behind to BEHIND, dirty to DIRTY, clean to CLEAN, blocked to BLOCKED, unstable to UNSTABLE, unknown to UNKNOWN), reads check-runs, and for a failed `ai-sdlc/pr-ready` run reads the failed job log and extracts the first `not ok` / `FAIL` / `Error:` line as `failingLine`, writing `.pr-facts.json`. `classify-prs` with no `--input` calls it. 4. Accelerated: one CLI call per tick instead of one model-driven fetch per PR. 5. Automated: the tick runs `classify-prs` alone; the dispatch command text shrinks to that one line.

## Acceptance Criteria

- [x] `cli-dispatch pr-facts` writes `.pr-facts.json` with `mergeStateStatus` in the GraphQL vocabulary for every open task PR; a mapping test covers all six values.
- [x] For a PR whose `ai-sdlc/pr-ready` check failed, `failingLine` holds the first failing line from the job log and is non-empty; a test uses a fixture log.
- [x] `classify-prs` without `--input` gathers facts itself; `--input` still works.
- [x] `ai-sdlc-plugin/commands/operator-dispatch.md` and `docs/operations/cli-hierarchy.md` drop the hand-assembly steps and name the one call.
- [x] Task file moved to `backlog/completed/` in the PR.

## Notes

GitHub calls go through the existing runner used by `pr-unstick` (`pipeline-cli/src/cli/pr-unstick.ts` already reads `mergeStateStatus` through `gh pr view`); reuse it rather than adding a client.
