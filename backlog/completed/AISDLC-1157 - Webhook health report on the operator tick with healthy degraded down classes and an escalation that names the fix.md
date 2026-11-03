---
id: AISDLC-1157
title: 'Webhook health report on the operator tick: healthy, degraded and down classes from receiver, port, event age, PR-activity-without-event and forwarder signals; degraded or down files a catalog escalation naming the fix, and cli-hierarchy status shows event age instead of "up"'
status: Done
assignee: []
created_date: '2026-11-02'
labels:
  - hierarchy
  - dispatch
  - observability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/drain-stall.ts
  - pipeline-cli/src/hierarchy/stall-notice.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

GitHub webhooks stopped reaching the local receiver on 2026-11-01 at 18:43 local and nobody noticed for about 22 hours (dispatch report 2026-11-02 ~17:20Z, verified by the planner). The receiver process (`cli-hierarchy webhook serve`, pid recorded in `.ai-sdlc/dispatch/webhook.json`) was alive the whole time and `cli-hierarchy status` printed `webhook: up (port 8765)`, which only means the pid answers. The feed into it (`gh webhook forward` or a tunnel, `docs/operations/cli-hierarchy.md` around line 380) is a separate process on the operator's account that is not registered anywhere, and it had died. Dispatch kept landing PRs because the reconcile path polls `gh`, at roughly 2,700 calls per hour, which is the rate-limit pressure seen on the status line.

Today `webhookStatus` (`pipeline-cli/src/hierarchy/webhook.ts` line 54) reports pid and port only; the tick (`dispatch-loop.ts`) has report kinds `progress`, `brief-complete` and `drain-stall` and none for the receiver; nothing reads the age of `.ai-sdlc/dispatch/events/`.

**Five-step review (requirements first).**
1. Requirement questioned: is "process alive" the health of the webhook path? No. Health is "events arrive when GitHub has something to say". The only observable that proves that is a recent event for a PR that recently changed, so the signal must be computed against PR activity, not against the clock alone.
2. Delete: the `up` wording when it is not backed by a recent event; the status line says what it knows.
3. Simplify: one `webhookHealth()` function returning `{ class, signals, since }` from five cheap signals, consumed by status and by the tick: receiver pid alive; port answering on `127.0.0.1`; age of the newest event file; PR activity without an event (a PR in `pr-snapshot.json` changed head or state within `staleAfterMinutes` and no event names it); forwarder alive (a `webhook.json` field `feed: { kind: gh-forward | tunnel | none, pid? }` written by `webhook up`, or a process match as a fallback). GitHub-side hook delivery status is optional and only when `gh api` reaches it within one call.
4. Accelerate: the report goes to the operator-dispatch session on the tick that detects a class change only (healthy to degraded, degraded to down, back to healthy), not every tick.
5. Automate: on `degraded` or `down` the tick files one `cli-decisions escalate --route operational` per episode naming the fix (restart the forwarder with the documented command, or re-register the hook), with the fix left to the operator since it touches the operator's account and network (class (c) under CLAUDE.md decision authority unless a later record says otherwise); it also fires the stall-notice channel once. A test drives the tick through the three classes with scripted signals.

Velocity impact: a dead feed is noticed within the threshold instead of a day, and the poll-only fallback (2,700 gh calls per hour) is visible as a degraded state rather than silent cost.

## Acceptance Criteria

- [x] AC-1: `webhookHealth(deps)` in `webhook.ts` returns `class: healthy | degraded | down` with the five signals above. Thresholds (config under `hierarchy.webhook`, defaults): `degraded` when no event for `staleAfterMinutes` (30) while a PR changed in that window, or the forwarder pid is gone while the receiver is up; `down` when the receiver pid or port is dead, or no event for `downAfterMinutes` (120) with PR activity. No PR activity in the window keeps `healthy` with signal `quiet`.
- [x] AC-2: `cli-hierarchy status` prints `webhook: <class> (port N, last event <age>, feed <kind|none>)`; the plain `up` wording is gone. JSON output carries the full signal object.
- [x] AC-3: The tick computes health once per tick and pushes a report of a new kind `webhook-health` on class change only; the hooks module forwards it to the operator-dispatch session like `drain-stall` and to the planner on `down`.
- [x] AC-4: On entering `degraded` or `down`, the tick files one `cli-decisions escalate --route operational` per episode (keyed by `since`) whose body names the fix command from `docs/operations/cli-hierarchy.md` and marks it operator-only; it fires `stall-notice` once. Returning to `healthy` closes the episode (a note on the decision). Covered by a test with a recording decision client and notifier.
- [x] AC-5: `webhook up` records the feed it started or was told about (`--feed gh-forward|tunnel|none`) in `webhook.json`; docs describe the classes, thresholds, the escalation and the restart command.

## Notes

Origin: dispatch session report 2026-11-02 ~17:20Z (evidence: newest event file 2026-11-01 18:43 local, 1,746 event files, receiver pid 65970 up 2d14h, repo hook list shows only a star-alert hook, no forwarder process found), verified by the planner the same hour. The stale-verdict-after-landing finding from the same report is AISDLC-1158, not this task. Related: AISDLC-880 (receiver), AISDLC-1156 (failed-verdict terminal states, same notification channel).

## Final Summary

## Summary
Fixed the reviewer's major finding. A PR that merges or closes no longer counts as webhook activity, so pruning its events can't push a working feed to degraded or down. `trackPrActivity` no longer records `lastClosedAt`, and `webhookHealth` counts only new PRs and head changes as activity. The test and `docs/operations/cli-hierarchy.md` are updated to match.

## Changes
- pipeline-cli/src/hierarchy/webhook.ts
- pipeline-cli/src/hierarchy/webhook.test.ts
- docs/operations/cli-hierarchy.md

## Design decisions
The finding offered two fixes: make the age signal survive pruning, or stop counting `lastClosedAt` once its events are pruned. I took a simpler third option: dropping the merge/close signal entirely. A merged PR's last events are pruned anyway, so it can't be matched against an event. After the rebase onto origin/main I pushed with --force-with-lease and the remote branch is at fdc0a4ff.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

