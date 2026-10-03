---
id: AISDLC-657.2
title: >-
  RFC-0050: align the default artifacts directory of the model resolver with the scorecard and replay commands
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - docs
dependencies:
  - AISDLC-657
references:
  - docs/operations/model-routing.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The model resolver (`pipeline-cli/src/routing/artifacts-dir.ts`) defaults its artifacts directory to `.ai-sdlc/artifacts` under the project, while `cli-usage scorecard` (`pipeline-cli/src/usage/scorecard-commands.ts`) and `cli-usage replay` (`pipeline-cli/src/usage/replay-commands.ts`) default to `artifacts`. With `ARTIFACTS_DIR` unset, the assignment log lands where the scorecard does not read, so the scorecard silently shows zero explored tasks. Make the defaults agree and update `docs/operations/model-routing.md`.

## Acceptance Criteria
- [x] With `ARTIFACTS_DIR` unset, the resolver, the scorecard and replay use the same directory, in a test.
- [x] The advice to set `ARTIFACTS_DIR` in `docs/operations/model-routing.md` is updated.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`. (Partly verified locally: build, `src/usage` + `src/routing` tests, eslint and prettier on touched files, and dark-code:check pass; the full workspace `pnpm test` was not run locally, CI runs it.)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
The model resolver, `cli-usage scorecard`, `cli-usage replay-corpus build` and `cli-usage replay` now share one artifacts-directory default, `<repoRoot>/.ai-sdlc/artifacts` (explicit value, then `$ARTIFACTS_DIR`, then that default), so the assignment log the resolver writes is the one the scorecard reads. The scorecard and replay commands print `Artifacts directory: <path>`. There is no fallback to the old `<repo>/artifacts`.

## Changes
- `pipeline-cli/src/routing/artifacts-dir.ts` (modified): shared `defaultArtifactsDir` / `resolveArtifactsDir`.
- `pipeline-cli/src/routing/resolve-model.ts` (modified): third copy of the default removed.
- `pipeline-cli/src/usage/scorecard-commands.ts`, `replay-commands.ts`, `replay-corpus.ts` (modified): use the helper and print the resolved directory.
- `pipeline-cli/src/usage/replay-commands.ts` (modified): the replay guard `isUnderAiSdlc` is narrowed from "refuse anything under `.ai-sdlc`" to "allow only `<repo>/.ai-sdlc/artifacts` and descendants". Real-path resolution, symlink refusal and case folding are kept, and the results path is now guarded too.
- `pipeline-cli/src/usage/artifacts-dir-alignment.test.ts` (new): alignment, guard and output tests.
- `docs/operations/model-routing.md` (modified): updated advice, including that pipeline runs need `ARTIFACTS_DIR` exported to one shared directory until the execute.md fix ships.

## Design decisions
- **Narrow the guard instead of removing it**: the default moved under `.ai-sdlc`, so the old guard would have refused it; allowing only the single artifacts subtree keeps attestations, verdicts and config protected.
- **No legacy fallback**: a silent fallback would hide a wrong directory; printing the resolved path makes it visible.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` - clean
- `vitest run src/usage src/routing` - 18 files, 321 tests passed
- `pnpm dark-code:check`, prettier and eslint on touched files - clean
- Full workspace `pnpm test` not run locally (known baseline failures in this environment); CI runs it
- Reviewers (code, test, Opus security) approved the final head with no critical or major findings; harnessTranscriptHash is null in this environment

## Follow-up
- declined: replay-corpus temp-file name (pid plus ms) could collide on two same-ms writes now that it uses `wx`; replay writes once per run
- declined: the pre-write results-path re-check and the `wx` exclusive-create behavior have no test; the early guard covers the same predicate and a mid-run symlink swap needs local write access to `.ai-sdlc`
- declined: `replay-corpus build` prints the directory after the write; cosmetic
- declined: the adopter scaffold ignore lists (`orchestrator/src/cli/commands/init.ts`, `orchestrator/src/execute.ts`) do not ignore `.ai-sdlc/artifacts`; reported to the operator as a possible follow-up
- declined: guard spelling variants (long s, Windows trailing dots) and anchoring on the worktree rather than the parent are existing limits, not made worse here
<!-- SECTION:FINAL_SUMMARY:END -->
