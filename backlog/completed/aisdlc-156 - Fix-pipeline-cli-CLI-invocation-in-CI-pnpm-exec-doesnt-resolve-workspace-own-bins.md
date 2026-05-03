---
id: AISDLC-156
title: >-
  Fix pipeline-cli CLI invocation in CI — pnpm exec doesn't resolve workspace
  own-bins, all 3 cost-saver CLIs silently failed
status: Done
assignee: []
created_date: '2026-05-02 20:43'
labels:
  - ci
  - bug
  - critical
  - cost-optimization
dependencies:
  - AISDLC-141
  - AISDLC-142
  - AISDLC-147
  - AISDLC-149
  - AISDLC-154
references:
  - .github/workflows/ai-sdlc-review.yml
  - pipeline-cli/bin/cli-classify-pr.mjs
  - pipeline-cli/bin/cli-incremental-decide.mjs
  - pipeline-cli/bin/cli-classify-budget.mjs
  - pipeline-cli/src/cli/bin-invocation.test.ts
  - pipeline-cli/README.md
  - CLAUDE.md
priority: highest
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ALL THREE pipeline-cli CLIs invoked by `.github/workflows/ai-sdlc-review.yml` were silently failing in CI, defeating the AISDLC-141, AISDLC-142, AISDLC-147, AISDLC-149, and AISDLC-154 cost optimizations entirely. Every PR ran full-budget reviewers, blew through Anthropic credits, and posted CHANGES_REQUESTED on credit exhaustion.

### Symptom (verified PR #201, run id 25268792976)

The `Analyze PR` job log shows the LITERAL fallback JSON shapes for all three CLIs:
- `Classifier decision: [testing critic security] (confidence: 0, fellOpen: true)` ← matches `cli-classify-pr` fallback
- `Incremental decision: no-marker` ← matches `cli-incremental-decide` fallback
- `Budget classifier: aggregate=proceed-as-normal exhausted=0/3` ← matches `cli-classify-budget` fallback

The job log has ZERO mentions of "credit balance" or "invalid_request_error" — the CLIs themselves never ran (only their `|| echo <fallback-json>` safety nets fired).

### Root cause

The workflow used:

```bash
RESULT=$(pnpm --silent --filter @ai-sdlc/pipeline-cli exec cli-XXX ... \
  || echo '<hardcoded-fallback-json>')
```

`pnpm exec` resolves binaries via `node_modules/.bin/`. Workspace packages do NOT symlink their OWN bin entries into their OWN `node_modules/.bin/` — only DEPENDENCIES are symlinked. So `pnpm --filter @ai-sdlc/pipeline-cli exec cli-classify-budget` looks for the bin in pipeline-cli's `node_modules/.bin/`, doesn't find it (since pipeline-cli IS the package that defines the bin, not a dependency), and errors with:

```
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "cli-classify-budget" not found
```

The fail-open `|| echo` semantics meant:
- `cli-classify-pr` fallback `{fellOpen:true}` → run all 3 reviewers (no AISDLC-141 optimization)
- `cli-incremental-decide` fallback `{skip:false, reason:"no-marker"}` → do full review (no AISDLC-142 optimization)
- `cli-classify-budget` fallback `{aggregate:"proceed-as-normal"}` → post CHANGES_REQUESTED on credit exhaustion (no AISDLC-147/149/154 protection)

Reproducible locally:

```
pnpm --filter @ai-sdlc/pipeline-cli exec cli-classify-budget --help
# → ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "cli-classify-budget" not found

node pipeline-cli/bin/cli-classify-budget.mjs --help
# → prints help
```

### Fix

Switched all 4 invocation sites in `.github/workflows/ai-sdlc-review.yml` (1× `cli-classify-pr`, 2× `cli-incremental-decide`, 1× `cli-classify-budget`) from `pnpm --silent --filter @ai-sdlc/pipeline-cli exec cli-XXX` to `node pipeline-cli/bin/cli-XXX.mjs`. The bin shims already use `#!/usr/bin/env node` and import the compiled dist module — no shim changes required.

Retained the `|| echo '<json>'` fallback so genuine CLI errors still fail-open. After the fix, the fallback fires ONLY on real CLI errors, not on invocation-resolution failures.

### Regression prevention

`pipeline-cli/src/cli/bin-invocation.test.ts` is the new hermetic guard. It:
1. Spawns each `bin/cli-*.mjs` via `node` from a real subprocess and asserts `--help` exits 0.
2. Asserts the broken `pnpm --filter @ai-sdlc/pipeline-cli exec cli-classify-budget --help` invocation STILL FAILS with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` / `Command not found`. If pnpm ever fixes own-bin resolution (or we move to a different package manager), this test fails LOUDLY and forces a deliberate re-evaluation of whether the simpler form can be reintroduced.

CLAUDE.md (CI behavior section) and `pipeline-cli/README.md` (new "Invoking from CI" subsection) document the rule prescriptively so future operators read it before touching the workflow.

### Impact

Until this lands, NONE of the cost optimizations were actually live in CI. After it lands, AISDLC-141/142/147/149/154 take effect on every PR.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 ALL 3 CLI invocation patterns in `.github/workflows/ai-sdlc-review.yml` switched to `node pipeline-cli/bin/cli-XXX.mjs` form (4 sites total: 1× cli-classify-pr, 2× cli-incremental-decide, 1× cli-classify-budget)
- [x] #2 Fallback `|| echo '<json>'` retained so genuine CLI errors still fail-open
- [x] #3 Hermetic regression test added at `pipeline-cli/src/cli/bin-invocation.test.ts` that verifies each bin is invokable via `node` AND that `pnpm exec` is still broken (defense against future workflow regressions)
- [x] #4 Documentation paragraph added to CLAUDE.md (CI behavior section) and `pipeline-cli/README.md` (new "Invoking from CI" subsection) explaining the rule and citing AISDLC-156
- [x] #5 Verified post-fix locally: `node pipeline-cli/bin/cli-classify-budget.mjs --help` exits 0 with help banner, end-to-end invocation returns real JSON (not the fallback shape)
- [x] #6 Existing `pipeline-cli/src/cli/*.test.ts` suites continue to pass (1039/1039 tests pass)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify cwd inside the worktree, read the workflow YAML to identify all 4 invocation sites
2. Switch each site from `pnpm --silent --filter @ai-sdlc/pipeline-cli exec cli-XXX` to `node pipeline-cli/bin/cli-XXX.mjs`, preserving every flag and stderr redirection
3. Add `pipeline-cli/src/cli/bin-invocation.test.ts` with two assertions per bin (file exists, `--help` exits 0) plus the broken-pattern guard
4. Update CLAUDE.md (CI behavior) and `pipeline-cli/README.md` (new "Invoking from CI" subsection) with prescriptive guidance + AISDLC-156 reference
5. Run the regression test + the full pipeline-cli vitest suite + lint + format:check
6. Verify a real direct-node invocation works end-to-end (returns real JSON, not the fallback shape)
7. Commit, push (`--set-upstream`), open PR
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- The task description claimed 3 invocation sites; the workflow actually has 4 (`cli-incremental-decide` is invoked twice — once for `decide`, once for `auto-approved-verdict`). All 4 are switched.
- `--silent` was dropped in the regression test's broken-pattern assertion (NOT in the workflow itself) because pnpm's `--silent` flag suppresses the `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` diagnostic, leaving the test with no error text to pattern-match. The CI failure mode is identical with or without `--silent` — both forms hit the same own-bin-resolution failure.
- Decision NOT to add `pnpm exec`-style scripts to `pipeline-cli/package.json` (Option B from the task brief). Direct `node` invocation has zero abstraction layers, no pnpm overhead per invocation, and can't silently break the same way. The bin shims already provide the right level of indirection (compiled dist resolution).
- The new test re-builds `dist/` if missing in `beforeAll` (single-shot, idempotent). Standard `pnpm test` runs after `pnpm build`, but local `pnpm --filter ... test` invocations may skip the build — this guards against that path.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL:BEGIN -->
## Summary
Switched all 4 pipeline-cli CLI invocation sites in `.github/workflows/ai-sdlc-review.yml` from the broken `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX` form to direct `node pipeline-cli/bin/cli-XXX.mjs` invocation. The pnpm form silently failed (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`) on every CI run because `pnpm exec` doesn't resolve workspace own-bins, causing the `|| echo <fallback-json>` safety nets to fire unconditionally and defeat the AISDLC-141/142/147/149/154 cost optimizations. Now they actually run.

## Changes
- `.github/workflows/ai-sdlc-review.yml` (modified): 4 invocation sites switched to `node pipeline-cli/bin/cli-XXX.mjs`; comments updated to cite AISDLC-156.
- `pipeline-cli/src/cli/bin-invocation.test.ts` (new): regression guard — spawns each bin via `node`, asserts `--help` exits 0, AND asserts the broken `pnpm exec` form still fails (so future workflow regressions trip a loud test failure).
- `pipeline-cli/README.md` (modified): new "Invoking from CI / GitHub Actions (AISDLC-156)" subsection explaining the rule.
- `CLAUDE.md` (modified): single-line prescriptive rule under "CI behavior" pointing to the README + the regression test.

## Design decisions
- **Direct `node` invocation over `pnpm` script indirection**: removes the pnpm layer entirely, can't silently break the same way, faster per invocation. The bin shims already provide the right level of indirection (compiled dist resolution).
- **Retain `|| echo <fallback>` fallback**: still want fail-open if the CLI genuinely errors. Post-fix the fallback fires ONLY on real CLI errors, not on invocation-resolution failures.
- **Two-direction regression test**: positive (each bin invokable via `node`) + negative (broken `pnpm exec` form still fails). The negative direction is the defense — it forces a loud failure if anyone reverts the workflow under stale assumptions, AND if pnpm ever fixes own-bin resolution it forces a deliberate re-evaluation.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1039/1039 tests pass (64 test files), including the new `bin-invocation.test.ts` (7 tests).
- `pnpm lint` — clean
- `pnpm format:check` — clean
- End-to-end manual invocation: `node pipeline-cli/bin/cli-classify-budget.mjs --testing-stdout /tmp/empty.txt ...` returns real JSON `{"aggregate":"proceed-as-normal","budgetExhaustedCount":0,...}`, not the literal fallback shape.

## Follow-up
(none — once this lands, AISDLC-141/142/147/149/154 take effect on every PR; subsequent PRs should show real classifier decisions and real budget signals in the `Analyze PR` job log).
<!-- SECTION:FINAL:END -->
