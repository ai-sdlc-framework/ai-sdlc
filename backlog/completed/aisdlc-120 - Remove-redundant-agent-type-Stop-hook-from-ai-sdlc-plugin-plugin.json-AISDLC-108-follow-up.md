---
id: AISDLC-120
title: >-
  Remove redundant agent-type Stop hook from ai-sdlc-plugin/plugin.json
  (AISDLC-108 follow-up)
status: Done
assignee: []
created_date: '2026-05-01 18:10'
labels:
  - plugin
  - hooks
  - claude-code
  - cleanup
dependencies: []
references:
  - ai-sdlc-plugin/plugin.json
  - .claude/settings.json
  - backlog/completed/aisdlc-108 - Delete-redundant-quality-gate-stop-Claude-hook-husky-pre-push-already-gates-verification.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

AISDLC-108 deleted the `quality-gate-stop.{sh,js,test.mjs}` hook files with the stated intent: "verification belongs on the git lifecycle, not every conversational turn." But two registrations were left behind:

1. **`.claude/settings.json` Stop block** referencing the deleted `quality-gate-stop.sh` — caused Stop hook failures on every session turn (operator hit it 2026-05-01; fixed by removing the registration in the same session).
2. **`ai-sdlc-plugin/plugin.json` agent-type Stop block** (lines 75-86) — calls Haiku with the same governance prompt (build/test/lint/blockedPaths). Same redundancy as the deleted shell hook, just with an LLM doing the work. Per AISDLC-108's intent, this should also be removed.

The second Stop block in plugin.json (`deferred-coverage-check.sh`) serves a different purpose (post-turn coverage check) and stays.

## Why now

Discovered while debugging the Stop-hook failure. The cleanup is small (~12-line block deletion) but completes AISDLC-108's intent properly so the convention is consistent end-to-end.

## Operator note

After landing, no Stop hooks should duplicate husky pre-push's verification. The dispatch loop, dev/reviewer subagents, and CI pipeline all do their own gating; per-turn LLM verification is redundant.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Remove the first Stop hook block (lines 75-86) from `ai-sdlc-plugin/plugin.json` — the agent-type Haiku governance check that re-runs build/test/lint/blockedPaths verification on every conversational turn
- [ ] #2 Keep the second Stop hook block (`deferred-coverage-check.sh`) — it's a different purpose (post-turn coverage check) and the script still exists
- [ ] #3 CHANGELOG entry under Unreleased > Removed: 'Agent-type Stop hook governance check from plugin.json (AISDLC-108 follow-up; the per-turn verification was redundant with the husky pre-push gate)'
- [ ] #4 Verify the plugin still loads cleanly after the change — run `pnpm --filter @ai-sdlc/plugin-mcp-server verify-bundle` to confirm no breakage
- [ ] #5 Document in CLAUDE.md under the existing AISDLC-108 mention: the cleanup is now complete — no Stop hooks remain that duplicate the husky pre-push verification
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Removed agent-type Haiku governance Stop hook from BOTH `ai-sdlc-plugin/plugin.json` AND `ai-sdlc-plugin/.claude-plugin/plugin.json` (the marketplace variant). Completes the AISDLC-108 cleanup chain — no Stop hooks remain that duplicate husky pre-push verification.

## Verification
- pnpm --filter @ai-sdlc/plugin-mcp-server verify-bundle — 5/5 checks pass
- pnpm build && pnpm test && pnpm lint && pnpm format:check — clean
- Both plugin.json files have valid JSON; Stop[] now 1-element (deferred-coverage-check.sh only)
- 3 reviews APPROVED: code 0c/0M/2m/0s (major sequencing addressed inline by also fixing .claude-plugin variant); test 0c/0M/0m/0s; security 0c/0M/0m/0s
<!-- SECTION:FINAL_SUMMARY:END -->
