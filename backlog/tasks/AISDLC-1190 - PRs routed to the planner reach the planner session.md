---
id: AISDLC-1190
title: 'PRs routed to the planner reach the planner session'
status: To Do
assignee: []
created_date: '2026-11-05'
labels:
  - dispatch
  - hierarchy
  - fix
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/hierarchy/send.ts
  - pipeline-cli/src/hierarchy/roster.ts
  - pipeline-cli/src/hierarchy/escalation-file.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-05: open PRs sat unlanded for days while waiting on the planner, and the planner did not know.

**Today.** When reconcile (`hierarchy/reconcile.ts`) decides `route-to-planner` (a `no-match` state, a `real-failure`, an action failed twice, or an aged head), `routeOnce` records the key `pr|headSha|reason` in `<board>/landing/planner-routes.json` under `sent` and pushes an `acted` entry with `ran: false`. Nothing sends it. `cli-dispatch reconcile --watch` (`cli/dispatch.ts`) only prints the report JSON to the watch process's own log. The record then shows the key as sent, so even a later fix would suppress it. The red-main `routed` field from `reportMainHealth` is also never read. Tick failures written by `cli-hierarchy escalation-file` (`TICK-*.json` under `<board>/escalations/`) reach no session either.

Effect on 2026-11-05: #2272 had been routed since 2026-11-01, #2307 and #2308 since 2026-11-02 and #2331 since 2026-11-03, all with dispatch idle and nothing queued. `cli-hierarchy status` showed 0 queued and 0 inflight, which reads as a quiet board.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the planner is the only tier that can unblock a routed PR, so a route that never reaches it is a dead end; the requirement stands. 2. Deleted: the false `sent` bookkeeping is replaced by a record of real deliveries. 3. Simplified: reuse `sendToRoster` and the roster's planner entry; no new channel. 4. Accelerated: the message goes out in the same reconcile pass that routes. 5. Automated: tests below.

1. **Deliver routes.** When `routeOnce` returns true, reconcile hands the route to an injected `notifyPlanner(text)`; the reconcile CLI wires it to `sendToRoster` with the roster's planner session. One line per route: `route-to-planner #<pr> <taskId> <reason> head <short sha> since <first route time>`. The key is recorded as sent only after a successful send; a failed send (no planner in the roster, socket error) leaves it pending and retries on the next pass, with one stderr line per failure.
2. **Red main.** The `routed` text from `reportMainHealth` goes through the same `notifyPlanner`.
3. **Tick failures.** `cli-hierarchy escalation-file` sends one line to the planner per new escalation file, deduplicated by message text within an hour, so a repeating tick failure does not flood.
4. **Show held PRs.** `cli-hierarchy status` prints a `ROUTED TO PLANNER` block: each open landing record whose action is `route-to-planner`, with PR, task, reason and how long it has waited. `ai-sdlc-plugin/commands/planner.md` Step 3 runs a command that prints the same list.
5. **Backfill.** Existing keys in `sent` are treated as undelivered once, so PRs routed before this change are reported on the first pass after deploy.
6. **Docs.** `docs/operations/cli-hierarchy.md` states where routes go and how to read the held list.

## Acceptance Criteria

- [ ] AC-1: A first route calls `notifyPlanner` once with the line above; the same key on a later pass does not. Tested.
- [ ] AC-2: A failed send leaves the key undelivered and the next pass retries it. Tested with an injected sender.
- [ ] AC-3: A red-main route reaches `notifyPlanner`. Tested.
- [ ] AC-4: A new escalation file sends one planner line; a repeat with the same message within an hour does not. Tested.
- [ ] AC-5: `status` lists every open `route-to-planner` record with its wait time, and prints nothing extra when there are none. Tested.
- [ ] AC-6: Keys recorded before this change are reported once after deploy. Tested.
- [ ] AC-7: The planner command shows the held list; docs updated.
