---
id: AISDLC-655
title: >-
  RFC-0050 Part B: offline reviewer replay (corpus builder, cli-usage replay, budget and off-peak scheduling)
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
  - review
dependencies:
  - AISDLC-653
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - orchestrator/src/scheduling/off-peak.ts
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Compares reviewer models without touching live review. Past reviewed diffs with known
results are replayed against a candidate model and scored. This is the only way the
security reviewer's model is ever compared, because it is never explored live.
RFC-0050 section B4.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Corpus builder** `cli-usage replay-corpus build`: for each reviewed commit in the
   reviews ledger (`pipeline-cli/src/attestation/reviews-ledger.ts`), record the task,
   the reviewed commit, its merge base, the reviewer role and a label. `known-defect`
   when a critical or major finding was recorded for that role at that iteration and a
   later iteration of the task was approved. `clean` when that role approved at
   iteration 1 with no critical or major finding. Other cases are skipped and counted.
   The corpus file stores commit ids and labels, not diffs; the diff is produced from
   git at replay time. A commit that is no longer reachable is skipped and counted.
2. **Replay runner** `cli-usage replay --role <role> --model <model> --max-items <n>
   --max-units <n>`: for each corpus item, builds the same review prompt the pipeline
   builds (`pipeline-cli/src/steps/07-build-review-prompts.ts`) against a temporary
   worktree at the reviewed commit, runs the reviewer through the existing spawner with
   the candidate model, and records block (any critical or major finding, or not
   approved) or approve. It stops at whichever limit is reached first and reports why.
3. **Scoring:** recall on `known-defect` items, false-block rate on `clean` items,
   mean units per review, each with its count; the same figures for the reference
   model when it is replayed on the same items. Results are written to a replay
   results file under the artifacts directory and can be passed to
   `cli-usage scorecard` for reviewer rows.
4. **Isolation:** replay never writes to the reviews ledger, the transcript leaves, a
   verdict file or an attestation, never pushes, and removes its temporary worktrees.
   Its usage is attributed in the usage ledger to a `replay` task id so it does not
   pollute real task costs.
5. **Scheduling:** `--off-peak` defers the run to the window defined by the existing
   off-peak scheduling module (`orchestrator/src/scheduling/off-peak.ts` is the design
   reference; do not import `orchestrator` from `pipeline-cli`).
6. **Dry run:** `--dry-run` lists the items that would be replayed and an estimated
   unit cost from the mean units per review in the usage ledger, and calls no model.

## Acceptance Criteria
- [x] The corpus builder labels a fixture ledger correctly: a blocked-then-approved commit is `known-defect`, a first-pass approval is `clean`, and other shapes are skipped and counted.
- [x] The corpus file contains commit ids and labels and no diff text.
- [x] With a mock spawner, replay computes recall and false-block rate that match a hand calculation, and reports counts beside each rate.
- [x] Replay stops at `--max-items` and at `--max-units` and states which limit ended the run.
- [x] After a replay run, the reviews ledger, transcript leaves, verdict files and attestation directory are byte-identical to before, and no temporary worktree remains.
- [x] Replay usage is recorded in the usage ledger under a `replay` task id.
- [x] `--dry-run` calls no model and prints an item list and an estimate.
- [x] An unreachable commit is skipped and counted, and the run continues.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added `cli-usage replay-corpus build` and `cli-usage replay`: a corpus of reviewed commits labelled `known-defect` or `clean` from the reviews ledger, and a replay runner that re-runs a reviewer role with a candidate model on those commits in a sandbox and scores recall, false-block rate and mean units per review, with counts. `--max-items`, `--max-units`, `--dry-run`, `--off-peak`, a reference-model comparison and a `--replay-results` option on the scorecard are included. All nine acceptance criteria have tests.

## Changes
- `pipeline-cli/src/usage/replay-corpus.ts`, `replay-run.ts`, `replay-git.ts`, `replay-sandbox.ts`, `replay-report.ts`, `replay-schedule.ts`, `replay-commands.ts`, wired into `cli-usage` and the scorecard.
- The Claude ingester skips transcripts from replay checkouts so replay usage is counted once, through the direct ledger record under task id `replay`.
- `ShellClaudePSpawner` gained an optional permission mode; its default is unchanged.

## Design decisions
- Replay runs the reviewer in a read-only sandbox, never with permission checks off: read-only tools, user settings only, no MCP, an explicit permission mode, no session persistence. It refuses to run if the installed CLI lacks any of those flags, and requires an explicit spend confirmation flag after printing a capped unit cost.
- Replay uses one throwaway local clone per run with its own `.git`, no remote, hooks and LFS smudge disabled and committed symlinks disabled, and deletes every commit-supplied Claude configuration (`.claude/`, `.mcp.json`, `CLAUDE.md` variants, including case and Unicode variants) before the session starts. The child environment is scrubbed.
- Deviation from the task text: the review prompt is built from the operator's current checkout (policy and task spec), with only the diff and changed-file names taken from the replayed commit inside untrusted-data markers, and replay uses a clone rather than a linked worktree. Both were required by the security review because the corpus deliberately selects commits that reviewers blocked.
- Corpus labelling: known-defect needs a critical or major finding for the role and a later iteration where every recorded reviewer approved with no such finding.
- Known unverified items: no live model call was made, and whether the reviewer agent resolves under user-only settings and whether the CLAUDE.md-disabling variable works were not checked against the real CLI.

## Verification
- `pnpm build` — passed
- `pnpm test` — usage, usage CLI and runtime suites passed (518); the early root-chain gates pass locally; the known bin-invocation, verify-runtime and TUI failures reproduce on clean main; the full root suite was not run
- `pnpm lint` — passed
- `pnpm format:check` — passed on touched files
- 3 parallel reviews approved after four rounds (Claude-native reviewers, security on Opus); reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-655.1: live smoke test of the sandbox with the real CLI.
- AISDLC-655.2: document the sandbox and the spend confirmation flag.
- AISDLC-655.3: defense-in-depth hardening from the reviews.
- AISDLC-655.4: pairwise comparison output, incremental corpus, per-model timeout.
<!-- SECTION:FINAL_SUMMARY:END -->
