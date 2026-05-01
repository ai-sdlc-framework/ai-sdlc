---
id: AISDLC-108
title: >-
  Delete redundant quality-gate-stop Claude hook (husky pre-push already gates
  verification)
status: Done
assignee: []
created_date: '2026-05-01 04:13'
updated_date: '2026-05-01 04:19'
labels:
  - plugin
  - hook
  - performance
  - developer-experience
  - orchestrator-mode
dependencies: []
references:
  - ai-sdlc-plugin/hooks/quality-gate-stop.sh
  - ai-sdlc-plugin/hooks/quality-gate-stop.js
  - .claude/settings.json
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-05-01 during the dogfood batch. The Stop hook configured at `.claude/settings.json` runs `ai-sdlc-plugin/hooks/quality-gate-stop.sh` at the end of every Claude turn ("Verifying governance compliance..." status). It scans `~/.claude/usage-data/tool-sequences.jsonl` (3.4MB / 19,049 lines) for source-file edits without matching `pnpm build`/`pnpm test`/`pnpm lint` Bash invocations, and on miss exits 2 (blocking) → wakes Claude with a stderr message → ~60s + nontrivial token cost on every turn-end during orchestrator sessions.

## The fix is simpler than originally framed: delete the hook

The Claude turn-end hook is **architecturally wrong**. Build/test/lint verification belongs in the **git lifecycle** (pre-commit / pre-push), not at every conversational turn boundary. We already have:

- `.husky/pre-commit` → runs lint-staged (prettier + ASCII-filename gate AISDLC-92)
- `.husky/pre-push` → runs `scripts/check-coverage.sh` which executes `pnpm -r test:coverage` workspace-wide AND enforces 80% line-coverage threshold

The pre-push gate IS the authoritative "did you actually run build/test/lint" check. It runs at the right boundary: when changes are about to leave the operator's machine. The Claude Stop hook duplicates this work but at the wrong granularity (every turn vs every push) and with the wrong consequence (wakes the model vs blocks the push).

The Stop hook also has known false-positive cases that the pre-push gate doesn't:

1. **Orchestrator sessions** that delegate verification to dev subagents (different sessionId) — the parent's hook scan sees source edits with no Bash verification, but the actual `pnpm test` ran in the subagent
2. **Conflict-resolution + finalize sessions** that edit CHANGELOG.md / task files / test files inline — the operator hasn't pushed yet, doesn't NEED to run verification at every conversational turn
3. **Multi-turn debugging** where edits + verification are interleaved across turns — the hook scans the FULL session history but Claude's working memory is per-turn, leading to "you forgot tests" prompts when the operator is mid-flow

## What changes

1. **Delete `ai-sdlc-plugin/hooks/quality-gate-stop.sh` + `quality-gate-stop.js`**
2. **Remove the `Stop` hook entry from `.claude/settings.json`** (it currently points at the deleted script)
3. **Document in CLAUDE.md** that the husky pre-push hook (`scripts/check-coverage.sh`) is the canonical verification gate. Direct contributors there if they're confused about what to run before pushing.
4. **Optional**: emit a one-line SessionStart message ("AI-SDLC: pre-push gate enforces build/test/lint at push time. Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before `git push` if you want to fail fast.") so net-new contributors know the gate exists without being woken every turn.

## Acceptance Criteria

1. `ai-sdlc-plugin/hooks/quality-gate-stop.sh` + `.js` deleted
2. `.claude/settings.json` `Stop` hook entry removed (the file's `hooks.Stop` array becomes empty or the key removed entirely)
3. `.husky/pre-push` (already exists, runs `scripts/check-coverage.sh`) is documented as the canonical verification gate in CLAUDE.md
4. SessionStart message (optional but encouraged) lets net-new contributors know about the pre-push gate
5. Verify: open a Claude session, make a code edit, end the turn — no "Verifying governance compliance..." status fires, no Stop-hook output in logs
6. Verify: try to `git push` without running `pnpm test:coverage` — pre-push gate fires (existing behavior, unchanged)
7. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
8. Plugin CHANGELOG entry under `Unreleased > Removed` documenting the hook removal + rationale

## Why this is better than the originally-proposed env-var opt-out

The original task framing was "add `AI_SDLC_ORCHESTRATOR_MODE=1` to skip the hook in orchestrator sessions". That's a band-aid — it accepts the wrong-layer placement and adds yet another knob to maintain. The deletion approach removes the wrong layer entirely; the right layer (husky pre-push) is already correct + already enforced.

## Performance impact

- Current: ~60s + tokens per turn-end in orchestrator sessions, 0s in non-orchestrator sessions where the hook scan finds matching Bash verifications
- After: 0s per turn-end. Pre-push gate behavior unchanged.

## References

- `ai-sdlc-plugin/hooks/quality-gate-stop.sh` + `quality-gate-stop.js` (to be deleted)
- `.claude/settings.json` (`Stop` hook entry to be removed)
- `.husky/pre-push` (canonical gate, documented)
- `scripts/check-coverage.sh` (the actual verification runner)
- Project memory: "Plugin Hook Friction" — this becomes the 7th friction point resolved
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Deleted the redundant Claude `Stop` hook (`ai-sdlc-plugin/hooks/quality-gate-stop.{sh,js,test.mjs}`) that ran build/test/lint verification at every conversational turn — the wrong layer that duplicated the canonical `.husky/pre-push` gate (`scripts/check-coverage.sh`, 80% threshold) and woke the model with false-positive stderr blasts during orchestrator sessions. Removed matching Stop-hook entries from `ai-sdlc-plugin/plugin.json` + `ai-sdlc-plugin/.claude-plugin/plugin.json` (preserving the deferred-coverage asyncRewake hook + Haiku governance verifier — those serve different purposes). Updated CLAUDE.md to document the pre-push gate as canonical + added a one-line SessionStart callout.

## AC status
- ✓ ACs #1, #3, #4, #7, #8 met
- ✗ AC #2 — `.claude/settings.json` Stop entry removal requires operator hand-edit. Claude Code's permission system denied Edit/Write on the file (separate from project blockedPaths). Operator must delete the `Stop` array (it currently references the now-deleted script). Once stripped, AC #5 (no "Verifying governance compliance..." status fires) is satisfied automatically.

## Verification
- All 6 remaining hooks tests green (69 tests / 8 suites): check-plugin-version, collect-tool-sequence, enforce-blocked-actions, permission-check, session-start, subagent-start
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- 3 reviews approved: code 0c/0M/1m/2s; test 0c/0M/2m/0s; security 0c/0M/0m/0s
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Operator follow-up
**Delete the `Stop` array from `.claude/settings.json`** (currently references the deleted `bash "$CLAUDE_PROJECT_DIR/ai-sdlc-plugin/hooks/quality-gate-stop.sh"`). Until the operator strips this, every session prints a startup error (missing-script Stop hook fails open — no enforcement risk, just noise).

## Follow-up (deferred from review, all non-blocking)
- session-start.test.mjs could add `assert.ok(ctx.includes('.husky/pre-push'))` to lock in the new callout wording
- Tutorial doc `docs/tutorials/08-claude-code-plugin.md` had pre-existing "6 hooks" claim — coincidentally aligned now
- CLAUDE.md "Canonical verification gate" bullet could be split into 2 sentences for readability
<!-- SECTION:FINAL_SUMMARY:END -->
