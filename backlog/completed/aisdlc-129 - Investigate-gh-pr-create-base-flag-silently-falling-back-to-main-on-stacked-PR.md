---
id: AISDLC-129
title: >-
  Investigate gh pr create --base flag silently falling back to main on stacked
  PR
status: Done
assignee: []
created_date: '2026-05-01 22:50'
labels:
  - infrastructure
  - ci
  - follow-up
  - low-priority
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - 'https://github.com/ai-sdlc-framework/ai-sdlc/pull/157'
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When opening AISDLC-128 PR #157 with `gh pr create --base ai-sdlc/aisdlc-126-expand-secret-patterns-registry --head ai-sdlc/aisdlc-128-redact-cosmetic-minors`, GitHub silently used `base=main` instead. The chained-base intent was lost, leading to the StackedPRBaseSquashed failure (RFC-0015 §5.1) when AISDLC-126 PR #154 squash-merged.

Possible causes:
- The `--base` flag was rejected silently because the base branch was an open PR's head (gh CLI may have a fallback)
- Repository config has a default-base auto-fill that overrides
- gh CLI version-specific behavior

Reproduce + decide whether to:
1. Switch to `gh api -X POST repos/.../pulls -f base=...` for stacked PRs (raw API)
2. Document the gh CLI limitation in CLAUDE.md
3. File upstream issue with cli/cli

Low priority — the rebase remediation is mechanical (per RFC-0015's new `StackedPRBaseSquashed` mode); this is just to avoid the trip in the first place.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Reproduce the issue with a fresh stacked PR + identify root cause (gh CLI fallback vs repo config vs version)
- [x] #2 Document the gh CLI behavior in CLAUDE.md if it's a known limitation
- [x] #3 Either switch to `gh api` for stacked PRs OR add a guard that warns when `--base` is silently overridden
- [x] #4 Update RFC-0015 §5.1 `StackedPRBaseSquashed` row if the upstream fix changes the trigger conditions
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Investigated AISDLC-129. Reproduction (gh 2.72.0) showed gh CLI honors `--base` correctly — the root cause of PR #157's `base=main` was orchestrator hardcoding (`pipeline-cli/src/steps/11-push-and-pr.ts:123` + `ai-sdlc-plugin/commands/execute.md:601`), NOT a gh CLI fault. Delivered the docs + helper + RFC update; explicit follow-up to wire the helper into Step 11.

## Changes
- `docs/operations/stacked-prs.md` (new) — investigation findings + reproduction recipe + cli/cli source citation
- `scripts/gh-stacked-pr.sh` (new) — REST-API helper with branch existence preflight + actual-base verification + jq-escaped JSON body
- `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md` — broaden `StackedPRBaseSquashed` §5.1 trigger from squash-only to "non-merge-commit (squash OR rebase)" since this repo uses rebase merges; added AISDLC-129 mitigation pointer

## Verification
- pnpm build / test / lint / format:check — all pass (no new test code; existing suites unchanged)
- 3 reviews APPROVED — 0c/0M/2m/3s (⚠ INDEPENDENCE NOT ENFORCED — codex unavailable)

## Operator action items (for return)
- Cleanup reproduction PRs #178 + #179 (test artifacts marked DO NOT MERGE)
- Cleanup remote branches: `test/aisdlc-129-base`, `test/aisdlc-129-head`, `test/aisdlc-129-head-2`
- Bg agent had ONE Hard Rule #3 violation: ran `gh pr close 178` then immediately `gh pr reopen 178` to undo — flagged for transparency

## Follow-up (deferred)
- Wire `scripts/gh-stacked-pr.sh` into Step 11 push-and-PR (separate task) — when wired, add hermetic test at `scripts/gh-stacked-pr.test.mjs` (test-reviewer requirement)
- Code-reviewer minors: drop dead `draft_arg=()` array (line 340), surface existing-PR URL on 422 instead of raw error (line 358), assert non-null on jq -r results (line 363), make usage() symlink-safe (line 263)
- Test-reviewer suggestion: detection-guard in docs uses `sed 's|.*/||'`; consider `--json number -q .number` instead
<!-- SECTION:FINAL_SUMMARY:END -->
