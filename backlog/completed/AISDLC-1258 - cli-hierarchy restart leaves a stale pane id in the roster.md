---
id: AISDLC-1258
title: cli-hierarchy restart leaves a stale pane id in the roster
status: Done
assignee: []
created_date: '2026-11-09'
labels:
  - fix
  - pipeline-cli
  - hierarchy
dependencies: []
priority: medium
dispatchable: true
---

## Description

Reported 2026-11-09 by the ai-sdlc-io planner on pipeline-cli 0.42.0: `cli-hierarchy restart ai-sdlc-io-operator-dispatch` printed `pid 76504 -> 25132` and opened a new pane `%722`, yet the roster still carried pane `%716`. Every later `cli-hierarchy send --to ai-sdlc-io-operator-dispatch` refused with "the recorded pane %716 does not belong to window ... (the roster entry is stale)", so the io planner lost its only channel to dispatch until a manual roster fix.

`pipeline-cli/src/hierarchy/restart.ts` replaces the whole entry with the one `launchSession` returns (`replaceEntry(deps, entry.name, next)`), so on reading the code the pane should be updated. The dev must find where the old pane survives before changing anything: candidates are `launchSession` returning an empty or pre-split `paneId` (the roster validator accepts `''`), `reRegisterDispatchServices` or the dispatch hooks module rewriting the entry from its own cached copy after the restart, or `send` reading a roster path other than the one `restart` wrote (board-dir vs project default).

## Five-step review (requirements first)

1. **Question the requirement.** `send` must refuse a pane that is not the named session's: that guard caught a real inconsistency and stays.
2. **Delete.** Nothing deleted.
3. **Simplify.** One writer of the roster entry per restart; whoever overwrites it afterwards loses, or re-reads the pane from tmux instead of a cached copy.
4. **Accelerate.** `restart` ends by re-reading the roster and asserting `paneId` equals the pane tmux reports for the new window; a mismatch is a loud error, not a silent success line.
5. **Automate last.** No new gate.

## Acceptance Criteria

- [x] Root cause named in the PR body with the reproduction (which writer left `%716` in place).
- [x] After `restart`, the roster entry's `paneId`, `pid` and `startedAt` all match the new tmux window; `restart` fails loudly when they do not.
- [x] `send --to <restarted session>` succeeds immediately after a restart (integration test under `pipeline-cli/src/hierarchy/`, tmux faked as the existing tests do).
- [x] `docs/operations/cli-hierarchy.md` restart paragraph states the post-restart consistency check.

## Notes

- Source: cross-session addendum from ai-sdlc-io-planner 2026-11-09 ~16:0xZ. Related io reports: AISDLC-1254 (webhook port, PR #2617), draft 1255 (hung tick send-keys), draft 1256 (launchd bootstrap), draft 1257 (step 10.5 dirty-worktree).

## Final Summary

## Summary
`restart` now reads the roster back after its write and throws if `paneId`, `pid` or `startedAt` disagree with the new tmux window. `status` now re-reads the roster before it persists reconciliation, which closes the one stale-writer path I found. I could not reproduce the exact incident, so the root cause is the likeliest writer, not a confirmed one.

## Changes
- pipeline-cli/src/hierarchy/restart.ts
- pipeline-cli/src/hierarchy/status.ts
- pipeline-cli/src/hierarchy/hierarchy.test.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1258 - cli-hierarchy restart leaves a stale pane id in the roster.md

## Design decisions
Likely cause: `status` read the roster and rewrote that snapshot after a concurrent restart finished, putting the old pane back. A freshly restarted session sits in `starting` until the harness registry lists it, and that is exactly the case `status` reconciles and writes. The fix re-reads the roster just before that write, and the PR body names this writer. Tests: `pnpm build`, `lint` and `format:check` passed; I ran only the hierarchy tests (1249 passed), not the full `pnpm test`. The pre-push hook ran its tests during the push. The new tests cover the post-restart field match, `send` target resolution right after a restart, and the loud failure on a mismatch. There is no test of the `status` race itself. AC 3 is covered by calling `resolveSendTarget` directly, not the `send` CLI. The PR is a draft. The task file got a one-line change (a claim-status edit made by the task tooling), which I committed as its own `chore(docs)` commit.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

