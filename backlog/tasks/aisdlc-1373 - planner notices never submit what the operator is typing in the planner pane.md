---
id: AISDLC-1373
title: 'Planner notices never submit what the operator is typing in the planner pane'
status: To Do
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - hierarchy
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/hierarchy/planner-notify.ts
  - pipeline-cli/src/hierarchy/planner-notify.test.ts
  - pipeline-cli/src/hierarchy/brief-notify.ts
  - pipeline-cli/src/hierarchy/send.ts
  - pipeline-cli/src/hierarchy/tmux.ts
  - pipeline-cli/src/hierarchy/types.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

**Gap.** Dispatch types its planner notices into the planner's tmux pane and presses Enter. If the operator has a message half typed in the planner composer, the notice is appended to it and the combined text is submitted. Reported on 2026-11-21 by the arcana-website-planner session (pipeline-cli 0.43.0) for the "pending" and "no-match" notices about arcana-website PR #83. The operator asked for this task to be filed.

**Facts read in code** (main at 687e0d596, paths under `pipeline-cli/src/`).

- `cli/dispatch.ts:536` always builds `createPlannerNotifier(boardDir, createSystemRunner())` and passes it to `reconcile()` at `:567`. No env var, flag, roster field or config key changes it.
- `hierarchy/planner-notify.ts:31` uses `send ?? createTmuxBriefSender(run)`. The `send` and `sendSocket` overrides are used only by tests.
- `hierarchy/brief-notify.ts:47-74`: `createTmuxBriefSender` checks the roster entry and pane identity, runs `send-keys -l <text>`, waits a fixed 400 ms (`SUBMIT_DELAY_MS`, `:36`) and sends `Enter`. It never looks at what the pane shows.
- `hierarchy/tmux.ts:244-253`: a pane check exists (`paneShowsPrompt`, `paneScreenAt`), but only `hierarchy/clear.ts:128-133` uses it.
- `hierarchy/send.ts:86-103`: `sendToRoster` uses the socket only when `to` is a received `uds:` address (`:70`, `:101`). A roster name always goes through the tmux sender (`:102`). `RosterEntry` (`hierarchy/types.ts:17-40`) has no socket or inbox field.
- Callers in `hierarchy/reconcile.ts`: `firstRoute` (`:753`, retry on error `:763-768`), `reportMainHealth` (`:746`), `reportDocsBump` (`:748`) and auto-enqueue (`:1375-1379`). The canary has its own copy at `cli/hierarchy.ts:1298-1310`.

**Observed** (from the peer report, not reproduced here). A half-typed operator message was submitted with a notice appended.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the planner must learn about a routed PR, a red main or a docs bump; it does not need the text typed into its composer. `cli-hierarchy status` already prints `held for planner` lines. 2. Deleted: the typing path for planner notices, when a non-typing channel is available. 3. Simplified: one notifier used by every caller, including the canary copy. 4. Accelerated: a notice is delivered at once over the channel, without waiting for an idle composer. 5. Automated: tests cover both the channel path and the fallback.

- Deliver planner notices over a channel that does not type into the composer: the session's inbox or socket (the same mechanism a received `uds:` address uses). Record the planner's address in the roster when the session starts, so a roster name can resolve to it.
- If no address is recorded, fall back to the tmux sender, but only when the composer is empty, using `paneShowsPrompt` or an equivalent pane read. When the composer is not empty, skip this pass; the existing retry in `firstRoute` and the other callers sends it on a later tick. Never send `Enter` over text the operator typed.
- Make the canary notifier in `cli/hierarchy.ts` use the same notifier.
- Update `docs/operations/cli-hierarchy.md` (planner session reference) to say how notices arrive.

Out of scope: messages to executors or to dispatch (executors have no operator typing); landing decision filing PRs (AISDLC-1374).

## Open questions

**Which channel does the roster record for the planner?** Option A: the Claude Code session socket. Option B: an inbox file in the board directory that the hierarchy hooks module shows to the session. Interim value: A when the session exposes a socket, otherwise B. The developer reads how `send.ts` already reaches received `uds:` addresses and reuses that path. Recommendation: A.

## Acceptance Criteria

- [ ] #1 A test shows that a planner notice with a recorded address goes over the socket or inbox and never calls `send-keys`.
- [ ] #2 A test shows that with no recorded address and a composer holding text, no `send-keys` and no `Enter` is sent, and the notice is retried on a later pass.
- [ ] #3 A test shows that with no recorded address and an empty composer, the notice is typed and submitted as today.
- [ ] #4 `reconcile.ts` callers and the canary notifier all use the same notifier (a test or grep check in the PR body).
- [ ] #5 `docs/operations/cli-hierarchy.md` describes how planner notices arrive.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
