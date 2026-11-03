---
id: AISDLC-1165
title: 'cli-decisions supersede writes its event through recordEvents; main is red on decisions-write-root.test.ts and every pre-push fails'
status: Done
assignee: []
created_date: '2026-11-03'
labels:
  - pipeline-cli
  - decisions
  - main-red
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/src/cli/decisions-write-root.test.ts
priority: high
dispatchable: true
---

## Description

Main is red. AISDLC-1161 (#2303) added the invariant test `recordEvents is the only direct appendDecisionEvent caller` in `pipeline-cli/src/cli/decisions-write-root.test.ts`. AISDLC-1162 (#2304) landed separately and its new `supersede` command calls `appendDecisionEvent(evt, { workDir })` directly (`pipeline-cli/src/cli/decisions.ts`, the supersede handler, about line 2171). Each PR was green alone; together the test finds two calls and fails.

The pre-push hook runs the pipeline-cli tests, so every code push in the repo is refused until this is fixed. Rebases of #2308 (AISDLC-1156) and #2271 (AISDLC-1087) are done locally and waiting on it.

**Five-step review (requirements first).**
1. Requirement questioned: the single write path from AISDLC-1161 stays; supersede must honour it like every other command.
2. Delete: the direct `appendDecisionEvent` call in supersede.
3. Simplify: call `recordEvents(argv, workDir, id, [evt])`, as the other commands do. This also gives supersede the `--file` routing for free.
4. Accelerate: unblocks every pending push.
5. Automate: the existing invariant test is the guard.

## Acceptance Criteria

- [x] AC-1: The supersede handler writes its event through `recordEvents`; `decisions.ts` contains exactly one `appendDecisionEvent(` call, inside `recordEvents`.
- [x] AC-2: `decisions-write-root.test.ts` passes and the existing supersede tests still pass; add one test that `supersede --file` routes through `cli-file` like `answer --file`.

## Notes

Semantic collision between two sibling PRs that landed on 2026-11-03. Found by the planner's rebase agents for #2308 and #2271.

## Final Summary

## Summary
Removed the duplicate 'supersede' entry that the earlier commit had added to the expected list in decisions-write-root.test.ts. The file now matches origin/main, so the invariant test passes. The supersede handler already writes through recordEvents, and decisions.ts has exactly one appendDecisionEvent( call. The new test that supersede --file routes through cli-file is in decisions-file-flag.test.ts.

## Changes
- pipeline-cli/src/cli/decisions-write-root.test.ts
- pipeline-cli/src/cli/decisions-file-flag.test.ts

## Design decisions
The branch was already up to date with origin/main when I rebased. I pushed with --force-with-lease and the PR already existed. The full build, test, lint and format:check run passed before the final commit, and the push only added the test fix and the review ledger commit.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

