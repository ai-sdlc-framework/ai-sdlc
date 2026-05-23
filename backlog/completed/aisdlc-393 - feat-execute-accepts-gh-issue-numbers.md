---
id: AISDLC-393
title: 'feat: /ai-sdlc execute accepts GH issue numbers (not just backlog task IDs)'
status: Done
labels:
  - cli
  - dogfood
  - ux
references:
  - ai-sdlc-plugin/commands/execute.md
  - dogfood/src/cli-watch.ts
  - dogfood/src/cli.ts
  - CLAUDE.md
priority:
  level: P1
size:
  tshirt: M
---

## Description

`/ai-sdlc execute` currently only accepts backlog task IDs (`AISDLC-NNN`). To run a GH issue through the pipeline on subscription billing today, operators have to mirror the issue into a backlog task by hand — duplicate state across two trackers for the same unit of work. The alternative is `pnpm --filter @ai-sdlc/dogfood watch --issue <id>`, which is GH-native but runs on **API-key billing** and doesn't match the canonical internal flow.

The split exists for billing reasons (subscription vs API key), not workflow reasons. The friction shows up the moment a real bug is filed as a GH issue (e.g. #610) and the operator wants to dispatch it on subscription. The right fix is to make the slash command accept the GH issue form and route internally, reusing what the watcher already does.

This task tracks #612.

## Acceptance criteria

- [x] AC-1: `/ai-sdlc execute <arg>` detects the argument form:
  - `^[A-Za-z][A-Za-z0-9]*-\d+$` (a prefixed task id like `AISDLC-NN` or `INGEST-NN`) → existing backlog-task path, no behavior change
  - `^#?\d+$` (a bare numeric or hash-prefixed numeric form) → new GH-issue path
  - `^gh:\d+$` (a `gh:`-prefixed explicit form) → unambiguous routing for the GH-issue path
- [x] AC-2: On the GH-issue path, the slash command uses `dogfood/src/dispatch-from-issue.ts` (`fetchGhIssueAsTaskSpec`) to fetch the issue and synthesize an in-memory `TaskSpec`. Hermetic test coverage in `dispatch-from-issue.test.ts`.
- [x] AC-3: The GH-issue dispatch path uses the **subscription `SubagentSpawner`** — `executePipeline()` receives the spawner from `defaultSpawner()` regardless of source kind, so the slash command body wires the subscription spawner through unchanged.
- [x] AC-4: No backlog task file is created as a side effect when dispatching from a GH issue. Step 4 skips the frontmatter patch (sentinel still written) and Step 10 skips the tasks/→completed/ move (verified via integration test in `execute-pipeline.test.ts`).
- [x] AC-5: The opened PR title contains `(closes #N)` and the PR body opens with `Closes #N` + uses `Closes #N` as the footer (verified via integration test that captures the `gh pr create` argv).
- [x] AC-6: When `/ai-sdlc execute` is invoked with an argument that doesn't match either form, exit with a clear error message listing the accepted forms — no silent failure.
- [x] AC-7: The existing watcher path (`pnpm --filter @ai-sdlc/dogfood watch --issue <id>`) is preserved unchanged for the API-key/unattended/CI use case.
- [x] AC-8: `CLAUDE.md` "Canonical execution paths" table updated to reflect that the slash command now accepts either form. Old "GitHub issue / unattended / CI → watcher" row remains; the slash-command row gains the GH-issue capability for subscription dispatch.
- [x] AC-9: Hermetic test coverage at the slash-command parser layer (form detection: AISDLC-NNN, NNN, #NNN, gh:NNN, malformed). Existing watcher tests left untouched.

## Implementation summary

The architectural decision: **Option A** (extend `executePipeline()` with `opts.taskSpec` + `opts.sourceKind`). The composite is the single dispatch entry point for both source kinds; two new options switch behaviour where it matters (Step 1 validate, Step 4 flip-status, Step 10 finalize, Step 11 push-and-pr).

Shipped in two commits:

1. **Commit 1 (`09c77739`)** — argument parser + slash-command form detection + hermetic tests (ACs 1, 6, 7, 8, 9). The GH-issue branch exited with a workaround pointer pending the architectural call.
2. **Commit 2 (this commit)** — `fetchGhIssueAsTaskSpec()` adapter + `executePipeline` extension (Steps 1/4/10/11 gh-issue branches) + slash-command wiring + integration + unit tests (ACs 2, 3, 4, 5).

### Files

- `dogfood/src/dispatch-from-issue.ts` (new): GH-issue → `TaskSpec` adapter with injectable `gh` runner.
- `dogfood/src/dispatch-from-issue.test.ts` (new): 20 hermetic cases covering AC parsing, label parsing, body block parsing, refusal modes.
- `pipeline-cli/src/types.ts` (modified): `PipelineOptions.{taskSpec, sourceKind, issueNumber}` + `PushAndPrOptions.{sourceKind, issueNumber}`.
- `pipeline-cli/src/execute-pipeline.ts` (modified): Step 1 inline-spec branch + threads `sourceKind`/`issueNumber` to Steps 4/10/11.
- `pipeline-cli/src/steps/04-flip-status.ts` (modified): skip backlog frontmatter patch for `'gh-issue'`; still write sentinel.
- `pipeline-cli/src/steps/10-finalize.ts` (modified): skip tasks/→completed/ move + frontmatter Done patch for `'gh-issue'`; sign attestation + chore-commit envelope when present.
- `pipeline-cli/src/steps/11-push-and-pr.ts` (modified): `composeTitle` + `composeBody` gh-issue branches produce `(closes #N)` / `Closes #N`.
- `pipeline-cli/src/execute-pipeline.test.ts` / `04-flip-status.test.ts` / `10-finalize.test.ts` / `11-push-and-pr.test.ts` (modified): new gh-issue integration + unit cases; existing backlog-path tests pass unchanged.
- `ai-sdlc-plugin/commands/execute.md` (modified): Step 1.a replaces the stub with a real `node -e` dispatch through `fetchGhIssueAsTaskSpec` + `executePipeline({ taskSpec, sourceKind: 'gh-issue', issueNumber, ... })`.
- `CLAUDE.md` (modified): partial-ship caveat removed; gh-issue dispatch shape documented.

## Out of scope

- Cross-repo dispatch (`owner/repo#NNN`)
- Bidirectional GH-issue sync (the issue stays authoritative; the pipeline writes back only via PR close)
- Backwards-compat for the legacy mirror-to-backlog flow (just deprecate it; nothing was officially documented as the supported path)

## References

- GH issue #612 — the source ask
- GH issue #610 — concrete instance of the friction (symlink bug filed as GH issue, can't dispatch on subscription today)
- `CLAUDE.md` → "Canonical execution paths"
- RFC-0012 — Two-tier pipeline architecture; the `SubagentSpawner` injection point is the rail-swap seam
- `dogfood/src/cli-watch.ts` — current GH-native dispatch implementation
