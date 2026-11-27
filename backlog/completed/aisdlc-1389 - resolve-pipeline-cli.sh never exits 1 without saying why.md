---
id: AISDLC-1389
title: 'resolve-pipeline-cli.sh never exits 1 without saying why'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - ai-sdlc-plugin
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
priority: medium
---

## Description

**Gap.** Most `exit 1` paths in `resolve-pipeline-cli.sh` print an `ERROR —` line, but the `ensure-pipeline-cli-built.sh` failure path (line ~252) prints nothing of its own and relies on the child's stderr. An adopter ran the script and got `rc=1` with empty stdout and stderr, so every command preamble failed with only `cannot resolve @ai-sdlc/pipeline-cli`.

**Failure.** arcana-website planner, 2026-11-22: `bash ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh; echo rc=$?` printed only `rc=1`, while `ai-sdlc-plugin/node_modules/@ai-sdlc/pipeline-cli/bin` existed.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a resolver may fail, but never silently. 2. Deleted: any exit path with no message of its own. 3. Simplified: route every exit through one `die <reason>` helper that prints the reason and the candidates tried. 4. Accelerated: none. 5. Automated: a test that runs the script in a fixture adopter layout and asserts a non-empty stderr for each failure.

- Reproduce first in an adopter-shaped checkout (plugin vendored under `ai-sdlc-plugin/` with its own `node_modules`), find which path exits silently, and record it in the PR.
- Every `exit 1` goes through `die`, which prints the reason and the list of topologies tried with why each failed.
- If the plugin's own `node_modules/@ai-sdlc/pipeline-cli/bin` exists and is usable, it resolves rather than failing.

## Acceptance Criteria

- [ ] #1 The silent path is identified in the PR description.
- [ ] #2 A test: each failure path prints a non-empty `ERROR —` line on stderr.
- [ ] #3 A test: an adopter layout with a usable vendored `node_modules` copy resolves.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
