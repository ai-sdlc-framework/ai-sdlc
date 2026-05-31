---
id: AISDLC-449
title: Auto-reverify cached blockers before extending passive heartbeat past N ticks
status: Done
assignee: []
created_date: '2026-05-27 22:09'
labels:
  - orchestrator
  - rfc-0015
  - vision-alignment
  - operator-friction
dependencies:
  - AISDLC-447
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - VISION.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Root cause of 18h passive monitoring loop on 2026-05-26→27. After context compaction, I trusted cached task-summary lines ("blocked on operator sign-off / CI race") without re-investigating the actual PR state. Real bug (v6 envelope filename) was always fixable.

The orchestrator-tick skill body has no rule that says "if you've been heartbeating with no state change for N ticks, re-investigate the cached blockers." Result: silent rot.



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [x] AC-1: orchestrator-tick skill body adds Step 6.5 "stale-cache reverify": after K consecutive ticks with no PR state change AND no new dispatches, re-fetch failing-check details for each BLOCKED PR
- [x] AC-2: K is configurable (default 2 for 1h cadence = 2h grace, ~3 for 20min cadence = 1h grace)
- [x] AC-3: When reverify surfaces a new actionable signal (e.g. failing check changed reason), surface via Decision Catalog or AskUserQuestion rather than silently heartbeat again
- [x] AC-4: When reverify confirms same blocker, escalate timebox urgency in Decision Catalog (depends on AISDLC-447)
- [x] AC-5: Tests + worked example in skill body docs

<!-- AC:END -->

## References

- spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
- ai-sdlc-plugin/commands/orchestrator-tick.md (Step 6 ScheduleWakeup)
- VISION.md §4 (Honest failure modes — no silent rot)
- AISDLC-447 (depends on timebox flag for AC-4)

## Final Summary

### Summary
Added a **Step 6.5 "stale-cache reverify"** gate to the `orchestrator-tick` skill body, backed by a new pure-logic module + CLI subcommands. After K consecutive ticks (default 2) with no blocked-PR state change AND no new dispatches, the Conductor re-fetches each blocked PR's failing-check details instead of silently heartbeating on a cached blocker summary — closing the 18h passive-monitoring-loop class of failure (2026-05-26/27). VISION.md §4 "no silent rot."

### Changes
- `pipeline-cli/src/orchestrator/stale-cache-reverify.ts` (new): pure, injection-friendly state logic — persisted passive-tick counter (`<board-dir>/passive-state.json`), `updatePassiveTickState` (increment on no-change / reset on change/dispatch/empty), `resolveReverifyK` (override → `AI_SDLC_STALE_CACHE_REVERIFY_K` env → default 2; non-positive falls back so a typo never disables the gate), `classifyReverifyResult`/`classifyReverifyBatch` (new-signal vs same-blocker), `fingerprintBlockedPrs` (order-insensitive), atomic read/write with corrupt-file fallback.
- `pipeline-cli/src/cli/dispatch.ts` (modified): new `reverify-blocked-prs` (advance counter + optional `--fresh` classification + `--dry-run`) and `reverify-k` subcommands.
- `ai-sdlc-plugin/commands/orchestrator-tick.md` (modified): Step 6.5 prose + cadence→K table + injection-safe bash recipe + the worked-example narrative of the 2026-05-26/27 incident.
- Tests: `stale-cache-reverify.test.ts` (new) + `dispatch.test.ts` (extended).

### Design decisions
- **Reused `cli-dispatch` rather than a new bin** for the reverify subcommands — minimizes bin wiring, consistent with the existing dispatch-board surface.
- **Skill body owns GitHub I/O; module owns pure logic** — all `gh pr checks` re-fetching stays in the bash recipe behind an injected boundary so the module stays hermetic/testable with no network.
- **AC-4 reuses AISDLC-447's shipped `cli-decisions extend --timebox URGENT`** surface rather than inventing a parallel escalation path.
- **Injection-safety (round-2 security finding):** the recipe constrains author-influenced check signatures via a shared `derive_check_signature` (`tr -cd`) helper and passes `$PR`/`$SIG` through `process.env` into every `node -e`, with pipe-delimited classifier output read via `IFS='|'`.

### Verification
- `pnpm build` — clean
- `pnpm test` (`@ai-sdlc/pipeline-cli`) — 5936 passed; line coverage 91.72% (>80% gate)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviewers approved (code/test/security), 2 rounds; round-2 closed the one major (security) + minors.

### Follow-up
- Non-blocking polish noted by reviewers: rename the recipe's loop vars (CPR/CSIG) for readability; align the charset prose with the `tr -cd '[:alnum:]:._,-'` code (comma). Neither affects behavior.

