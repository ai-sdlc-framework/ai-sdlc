---
id: AISDLC-451
title: >-
  Frontier triage rubric — cross-check tasks for already-shipped / closed-PR /
  blocked-on-OQ before dispatch
status: Done
assignee: []
created_date: '2026-05-27 22:10'
labels:
  - frontier
  - rfc-0014
  - dor-rubric
  - operator-friction
  - vision-alignment
dependencies: []
references:
  - pipeline-cli/src/cli/deps.ts
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - VISION.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Origin: 2026-05-27 session. cli-deps frontier returned 14 "ready" tasks; on inspection: 1 already shipped (the work was on main, but the task file remained in tasks/), 1 explicitly blocked (a task with `blocked.reason`), 1 had a failed prior PR (closed without merge), 4 OQ-refinements awaiting walkthrough, plus a couple of session-list items that referenced backlog IDs that had never been filed as backlog files. I burned ~15 min triaging instead of dispatching.

The DoR rubric checks shape + references but doesn't cross-check execution state. A task can pass DoR and be in `backlog/tasks/` while its work has already shipped, or its prior PR is closed, or the task ID is fictitious.



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [x] AC-1: cli-deps frontier output includes a "dispatch-readiness" signal per task: {ready, stale-shipped, closed-prior-pr, blocked, missing-id}
- [x] AC-2: Stale-shipped check: grep CLAUDE.md and recent commit messages for task ID + "already done" / "shipped" / "default-on" keywords; flag stale tasks
- [x] AC-3: Closed-prior-PR check: query `gh pr list --search "AISDLC-N" --state closed` and surface any non-merged closed PRs
- [x] AC-4: Blocked check: parse `blocked.reason` from frontmatter (already partially done by upstream-OQ gate)
- [x] AC-5: Missing-ID check: backlog/tasks/ or backlog/completed/ files must exist for any task surfaced
- [x] AC-6: orchestrator-tick Step 5 (fill-to-cap) skips non-ready tasks AND surfaces them in next Decision Catalog tick: "frontier candidate X is stale-shipped — close task file?"
- [x] AC-7: Cleanup task: sweep current backlog/tasks/ for already-shipped entries and move to completed/

<!-- AC:END -->

## Final Summary

### Summary

Added `pipeline-cli/src/dor/dispatch-readiness.ts` — a new module that computes one of five dispatch-readiness verdicts per task ID (`ready` | `stale-shipped` | `closed-prior-pr` | `blocked` | `missing-id`) by running independent checks against the local backlog filesystem, `git log` on `origin/main`, and `gh pr list --state closed`. Wired into `cli-deps frontier` behind a new opt-in `--check-dispatch-readiness` flag (off by default — preserves the fast path for cli-deps consumers that don't need the rubric). The orchestrator-tick Step 5 fill-to-cap loop now passes the flag and skips non-ready frontier candidates, surfacing them as recommendation lines for the operator (or a downstream automation) to file as Decision Catalog entries. Swept two true-positive stale-shipped tasks (AISDLC-259, AISDLC-392) from `backlog/tasks/` to `backlog/completed/` as part of AC-7.

### Changes

- `pipeline-cli/src/dor/dispatch-readiness.ts` (new): the rubric module — `checkDispatchReadiness(taskId, opts)` returns `{readiness, reason, evidence}`. Pure with respect to the filesystem (helpers exported for hermetic test injection).
- `pipeline-cli/src/dor/dispatch-readiness.test.ts` (new): 27 tests covering all 5 verdicts + precedence + degrade-open + batch helper + ID canonicalisation.
- `pipeline-cli/src/cli/deps.ts` (modified): added `--check-dispatch-readiness` flag to `cli-deps frontier`; emits `dispatchReadiness` + `dispatchReadinessReason` + `dispatchReadinessEvidence` per JSON frontier entry; annotates the table format with `[<verdict>]` suffix when verdict ≠ `ready`.
- `pipeline-cli/src/cli/deps.test.ts` (modified): added 5 tests for the new flag (back-compat omits field; ready surfaces; blocked surfaces; table annotation; ready entries are NOT annotated).
- `ai-sdlc-plugin/commands/orchestrator-tick.md` (modified): Step 5 fill-to-cap probe now uses `--check-dispatch-readiness`; HAS_READY parser filters out `dispatchReadiness !== 'ready'` entries; emits a "AISDLC-451 frontier triage" recommendation line per non-ready candidate so the operator can route it through `cli-decisions add`.
- `backlog/completed/aisdlc-259 - …` (renamed from `backlog/tasks/`): AC-7 sweep — TUI fix landed in `(AISDLC-259)` commit `4326a800` on origin/main, file lingered in `tasks/`. Flipped status: Done.
- `backlog/completed/aisdlc-392 - …` (renamed from `backlog/tasks/`): AC-7 sweep — Decision Catalog feature-flag promotion landed in `(AISDLC-392)` commit `ce6811fa`. Flipped status: Done.

### Design decisions

- **Strict subject-line literal matching for stale-shipped.** First implementation used `git log --grep '\(AISDLC-N\)\|AISDLC-N:'` which (a) treated `\(...\)` as BRE grouping (matching any substring), and (b) scanned commit bodies. The OQ-walkthrough commits like `(AISDLC-447..451)` (range-suffix) with bodies that legitimately mention adjacent task IDs caused mass false-positives — every task in the range got flagged. Switched to `git log --format=%h %s` (subject-only, no `--grep`) + JS-side substring filter on `(AISDLC-N)`. Trade-off: misses ship-commits that use a different suffix convention (e.g. trailing `AISDLC-N:` colon-form), but the dogfood corpus is 100% on the paren-suffix convention; the false-positive cost outweighs the false-negative cost in operator triage time.
- **Verdict precedence is missing-id → blocked → stale-shipped → closed-prior-pr → ready.** Designed to surface the most decisive signal first: `missing-id` makes other checks impossible (no file to read); `blocked` is an explicit operator decision that overrides everything else; `stale-shipped` is more decisive than `closed-prior-pr` (a merged commit is harder to misinterpret than a PR closure).
- **Opt-in flag, default off.** The two external calls (`git log`, `gh pr list`) add ~100-300ms per frontier entry. Keeping the default off preserves the fast path for consumers that don't need triage (legacy callers, the JSON snapshot pipeline). The orchestrator-tick Step 5 turns it on explicitly because the alternative is dispatching a dev subagent for stale work — orders of magnitude more expensive than the gh round-trip.
- **Step 5 recommends rather than auto-files Decision Catalog entries.** Filing a `cli-decisions add` per non-ready candidate from inside the orchestrator-tick loop would create duplicate Decision records across rapid ticks. Step 5 instead emits a recommendation line per candidate; the operator (or a future deduplication wrapper) decides whether to file the Decision.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test -- src/dor/dispatch-readiness.test.ts` — 27/27 passed
- `pnpm --filter @ai-sdlc/pipeline-cli test -- src/cli/deps.test.ts` — 44/44 passed (5 new + 39 existing)
- Manual dogfood run: `node pipeline-cli/bin/cli-deps.mjs frontier --format json --check-dispatch-readiness` correctly flagged AISDLC-259 + AISDLC-392 as stale-shipped (verified via `git log --grep '(AISDLC-N)' origin/main`).

### Follow-up

- The 3 remaining `blocked` tasks (AISDLC-270, 384, 429) are intentional operator holds — out of scope for AC-7's "already-shipped sweep". They surface correctly via the new rubric.
- Closed-prior-PR rubric is exercised via injected stubs in tests but not yet against the live `gh pr list` corpus — would benefit from a one-shot dogfood pass after merge to catch any tasks with a closed-without-merge PR history.

## References

- pipeline-cli/src/cli/deps.ts (frontier command)
- pipeline-cli/src/dor/upstream-oq-gate.ts (existing blocked check)
- ai-sdlc-plugin/commands/orchestrator-tick.md (Step 5 fill-to-cap)
- spec/rfcs/RFC-0014-dependency-graph-composition.md
- spec/rfcs/RFC-0011-definition-of-ready-gate.md
- VISION.md §3 (Operator's role: decision steward, not bug triager)

