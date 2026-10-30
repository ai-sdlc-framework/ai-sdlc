---
id: AISDLC-1119
title: pre-push hook runs the CI patch-coverage script over the changed lines of the touched packages, so coverage gaps are fixed in the developer round instead of a CI round-trip
status: To Do
assignee: []
created_date: '2026-10-30'
labels:
  - ci
  - coverage
  - hooks
  - velocity
priority: high
references:
  - .husky/pre-push
  - scripts/check-pr-patch-coverage.mjs
  - .ai-sdlc/patch-coverage.yaml
  - .github/workflows/ai-sdlc-gate.yml
  - ai-sdlc-plugin/agents/developer.md
  - vscode-hierarchy/vitest.config.ts
  - docs/operations/quality-gate.md
---

## Description

Since the local coverage run left the pre-push hook on 2026-10-10 (one coverage gate, in CI), the first time a developer learns that its patch is under the 90 percent line (89 after the one-point tolerance in `.ai-sdlc/patch-coverage.yaml`) is a red `ai-sdlc/pr-ready` after the push. On 2026-10-30 three of the thirteen red ready PRs failed only there: #2150 at 88.71 percent, #2060 at 86 percent, #2158 with "no coverage data" for a file in `vscode-hierarchy`, a package whose coverage output the gate never sees. Each one costs a reenter, a fresh developer round and a review round for a two-minute test addition. The developer prompt's only coverage sentence names a different metric (package lines, 95 percent) and says nothing runs it, so executors do not run coverage at all.

The hook that was removed measured whole-package floors across the entire workspace and flaked when several worktrees ran it at once over a shared temp directory. The patch gate is a different, cheaper check: it needs coverage data only for the packages whose files the diff touches, and `scripts/check-pr-patch-coverage.mjs` already computes the result from a base and head sha, exactly as CI does.

**Five-step review (requirements first).** Requirement questioned: does a pre-push gate contradict "CI is the single coverage gate" (AISDLC-726)? No: CI stays the only gate that blocks a merge; the hook is an early copy of the same check with the same script and threshold, so there is no second standard and nothing to keep in sync beyond the YAML both already read. Deletion: delete the "95 percent lines" coverage sentence from the developer prompt (wrong metric, never executed). Simplified: one script, one threshold file, one new hook step; the hook never computes anything the script does not already compute. Accelerated: the gap is found before the push, in the worktree that still has the developer and its context, instead of after a CI run plus a reenter. Automated: the hook runs on every push from every worktree, executor or human, with no prompt rule to remember.

## Fix

1. `.husky/pre-push`: after the existing dark-code and typecheck steps add a patch-coverage step.
   - Compute `BASE=$(git merge-base HEAD origin/main)` (fetch is not performed by the hook; a missing `origin/main` skips the step with one line).
   - List changed files `git diff --name-only "$BASE" HEAD`. If the script's own code-file filter (export the predicate it already uses for the skip case, or add `--list-changed`) yields no code files, print one skip line and exit 0.
   - Map the changed code files to workspace packages by their first path segment and run `pnpm --filter <pkg> test:coverage` for each touched package only, sequentially. Nothing runs for untouched packages.
   - Run `node scripts/check-pr-patch-coverage.mjs --base "$BASE" --head HEAD`; its exit code is the hook's. Print the script's human summary (uncovered line ranges per file) so the developer can act on it.
   - Skip variable `AI_SDLC_SKIP_PATCH_COVERAGE_GATE=1`, logged in the hook's existing skip line; the pre-push discipline rule (never routine) applies. Document it in the hook header where the other skip variables are listed.
2. `scripts/check-pr-patch-coverage.mjs`: accept `--head HEAD` and a merge-base sha the way CI passes two shas (no behaviour change for CI); expose the changed-code-file predicate so the hook does not duplicate the extension list.
3. `vscode-hierarchy/vitest.config.ts`: emit the `json` coverage reporter into `./coverage` like the other packages so the gate sees its files; fix the `clock.ts` "no coverage data" case from #2158.
4. `ai-sdlc-plugin/agents/developer.md`: replace the "run coverage once before your first push ... 95 percent lines; nothing runs it for you" sentence with one line: the pre-push hook runs the patch-coverage gate over your changed lines; when it fails, add tests for the uncovered ranges it prints and push again.
5. `docs/operations/quality-gate.md`: one paragraph under the coverage section: the gate runs twice with the same script and threshold, at pre-push over the touched packages and in CI over the whole workspace; CI is the one that blocks a merge.

## Velocity impact

Adds one coverage run per push, scoped to the touched packages (pipeline-cli or orchestrator alone: about the length of their normal test run, since vitest coverage is the same run with instrumentation). Removes, per under-covered PR, a CI run, a reenter, a developer round and a review round. Break-even is well under one caught PR per day; 2026-10-30 had three before noon.

## Acceptance Criteria

- [ ] A push whose diff against `origin/main` has 88 percent patch coverage is refused by the hook with the uncovered line ranges printed; adding the tests makes the same push pass without any env var.
- [ ] A docs-only or test-only push runs no coverage and prints one skip line.
- [ ] A push touching only `pipeline-cli` runs `test:coverage` in `pipeline-cli` only (verified in the hook output).
- [ ] The hook and the CI gate read the same threshold from `.ai-sdlc/patch-coverage.yaml`; changing the YAML changes both.
- [ ] A change to `vscode-hierarchy/src/clock.ts` produces coverage data the script finds (no "NO coverage data" outcome).
- [ ] `ai-sdlc-plugin/agents/developer.md` no longer mentions a 95 percent package line target; `pnpm test:plugin-model-pins-gate` and the prompt-rules tests stay green.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; the change's own patch coverage at or above the gate.

## Out of scope

- Reintroducing whole-package coverage floors locally.
- Any change to the CI threshold or tolerance.
