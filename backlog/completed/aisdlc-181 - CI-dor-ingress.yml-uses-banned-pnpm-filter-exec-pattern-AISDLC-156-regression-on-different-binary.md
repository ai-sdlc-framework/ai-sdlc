---
id: AISDLC-181
title: >-
  CI: dor-ingress.yml uses banned pnpm --filter exec pattern (AISDLC-156
  regression on different binary)
status: Done
assignee: []
created_date: '2026-05-04 03:18'
labels:
  - bug
  - ci
  - framework-bug
dependencies: []
references:
  - .github/workflows/dor-ingress.yml
  - pipeline-cli/bin/ai-sdlc-pipeline.mjs
  - pipeline-cli/src/cli/bin-invocation.test.ts
  - >-
    backlog/completed/aisdlc-156 -
    Fix-pipeline-cli-CLI-invocation-in-CI-pnpm-exec-doesnt-resolve-workspace-own-bins.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`.github/workflows/dor-ingress.yml` invokes `pnpm --filter @ai-sdlc/pipeline-cli --silent exec ai-sdlc-pipeline dor-evaluate ...` at four call sites (lines 81, 127, 279, 310). Per AISDLC-156's discovery, `pnpm exec` does not resolve workspace own-bins — the binary `ai-sdlc-pipeline` ends up "Command not found" and the wrapping shell `OUT=$(...)` captures empty + exits 1 (with `--silent` suppressing the error message).

Observed on PR #238 (chore/aisdlc-179-180-orchestrator-bugs): "Evaluate backlog tasks changed by PR" check fails with cryptic `##[error]Failed to evaluate backlog/tasks/aisdlc-179-... (exit 1)` with no stderr because `--silent` swallows pnpm's "Command not found".

## Root cause

Same as AISDLC-156: `pnpm exec` doesn't resolve workspace own-bins. The fix landed for `cli-classify-pr` / `cli-incremental-decide` / `cli-classify-budget` invocations, but the umbrella binary `ai-sdlc-pipeline` was missed in that sweep.

## Fix

Replace all four occurrences in `.github/workflows/dor-ingress.yml` with direct `node pipeline-cli/bin/ai-sdlc-pipeline.mjs` invocation, matching the AISDLC-156 pattern:

```yaml
# Before
OUT=$(pnpm --filter @ai-sdlc/pipeline-cli --silent exec ai-sdlc-pipeline \
  dor-evaluate "$ID" --body-file "$f" --source backlog --hermetic)

# After
OUT=$(node pipeline-cli/bin/ai-sdlc-pipeline.mjs \
  dor-evaluate "$ID" --body-file "$f" --source backlog --hermetic)
```

## Severity

**Medium.** PR merge gate (`ai-sdlc/pr-ready`) is unaffected — DoR Ingress is informational. But the failure still red-flags every PR that touches `backlog/tasks/*.md` files, which is most operator work. Operator must mentally filter "is this DoR ingress red because of THIS failure or a real DoR issue?"

Per RFC-0025 framework-quality taxonomy: `framework-coverage-gap` — the AISDLC-156 enforcement test (`pipeline-cli/src/cli/bin-invocation.test.ts`) didn't catch this because it checks for `cli-XXX` patterns, not the umbrella `ai-sdlc-pipeline` binary.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 All four `pnpm --filter @ai-sdlc/pipeline-cli ... exec ai-sdlc-pipeline` invocations in .github/workflows/dor-ingress.yml replaced with `node pipeline-cli/bin/ai-sdlc-pipeline.mjs`
- [x] #2 pipeline-cli/src/cli/bin-invocation.test.ts extended to cover the `ai-sdlc-pipeline` umbrella binary in workflow files (not just the per-CLI scripts)
- [x] #3 Verify locally: re-running PR #238 (or any open PR with backlog/tasks changes) shows DoR Ingress check passing
- [x] #4 If any other workflow uses the same broken pattern with `ai-sdlc-pipeline` or other umbrella binaries, apply the same fix in the same PR
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Verified all 4 ACs already met by prior work (likely shipped via the AISDLC-156 followup sweep that this task documents):

- AC #1: dor-ingress.yml lines 81, 127, 292, 323 already use `node pipeline-cli/bin/ai-sdlc-pipeline.mjs` directly (no `pnpm --filter exec`)
- AC #2: bin-invocation.test.ts has UMBRELLA_BIN coverage (line 83) + invocation test (line 154) + dor-ingress.yml reference comment (line 312)
- AC #3: PRs landing today (#332, #333, #334, #335, #336, #337, #338, #339, #340, #341 in flight) all touch backlog/tasks and DoR Ingress fires cleanly
- AC #4: ripgrep'd .github/workflows/ for `pnpm.*exec.*ai-sdlc-pipeline` — no remaining occurrences

This PR is the bookkeeping lifecycle close — file move tasks/→completed/, status flip, AC checkboxes, finalSummary. Same shape as AISDLC-184/175/191 lifecycle-close PRs earlier today.
<!-- SECTION:FINAL_SUMMARY:END -->
