---
id: AISDLC-181
title: >-
  CI: dor-ingress.yml uses banned pnpm --filter exec pattern (AISDLC-156
  regression on different binary)
status: To Do
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

- [ ] #1 All four `pnpm --filter @ai-sdlc/pipeline-cli ... exec ai-sdlc-pipeline` invocations in .github/workflows/dor-ingress.yml replaced with `node pipeline-cli/bin/ai-sdlc-pipeline.mjs`
- [ ] #2 pipeline-cli/src/cli/bin-invocation.test.ts extended to cover the `ai-sdlc-pipeline` umbrella binary in workflow files (not just the per-CLI scripts)
- [ ] #3 Verify locally: re-running PR #238 (or any open PR with backlog/tasks changes) shows DoR Ingress check passing
- [ ] #4 If any other workflow uses the same broken pattern with `ai-sdlc-pipeline` or other umbrella binaries, apply the same fix in the same PR
<!-- AC:END -->
