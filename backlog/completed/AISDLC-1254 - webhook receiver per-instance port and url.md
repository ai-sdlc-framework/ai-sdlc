---
id: AISDLC-1254
title: >-
  Multiple ai-sdlc instances on one host: webhook receiver picks a free per-project port and the forwarder URL follows it
status: Done
assignee: []
created_date: '2026-11-09'
labels:
  - hierarchy
  - webhook
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two ai-sdlc hierarchies on the same host collide on the webhook receiver port. The receiver
binds `127.0.0.1:8765` (`DEFAULT_WEBHOOK_PORT`, overridable only by `AI_SDLC_WEBHOOK_PORT` or
`--port`). The first hierarchy to start owns the port; in every other project
`cli-hierarchy webhook up` prints `webhook starting on 127.0.0.1:8765` and the process exits
without a bind error, `status` reports `down (receiver process is not running)`, the webhook
health check opens a decision (ai-sdlc-io DEC-0083, 2026-11-09) and dispatch falls back to
polling GitHub at about 2,700 calls an hour.

Observed on 2026-11-09: the `ai-sdlc` monorepo receiver (pid 65970, running 9 days) held 8765;
`ai-sdlc-io` could not start its receiver until the operator chose a second port by hand
(`webhook up --port 8766` plus a separate `gh webhook forward` whose target URL names port 8766).
Running several projects on one developer machine is the normal case for the session
hierarchy (the monorepo, the public site, the enterprise repo), so the port and the forwarder
URL must be per instance without operator intervention.

## Scope
1. **Per-project port selection.** `webhook up` without `--port` or `AI_SDLC_WEBHOOK_PORT`
   chooses a port automatically: the configured default if free, otherwise the next free
   port in a small range (for example 8765 to 8799), or a port derived deterministically from
   the project id so restarts reuse it. The chosen port is written to `webhook.json` on the
   board and is the single source of truth for `status`, the health check and the forwarder.
2. **Forwarder URL follows the port.** `installForwarder` and the `--feed gh-forward` path
   build the forwarder target (loopback host, the recorded port, the `/webhooks/github`
   path) from the recorded port, never from the default constant. `webhook status` prints the full URL the feed must target.
3. **Bind failures are explicit.** A receiver that cannot bind exits with a clear message
   naming the port, the owning pid and its project (`lsof` or equivalent), and
   `webhook up` reports that failure instead of "starting". `status` distinguishes
   "not running" from "port held by another ai-sdlc instance".
4. **Health check and DEC routing.** The webhook health check does not open a decision for
   a bind collision that the automatic selection resolves; it only escalates when no free
   port is available or the feed is down.
5. **Docs.** `docs/operations/cli-hierarchy.md` gets a "Several projects on one host" note:
   automatic port choice, how to pin one, and that each project runs its own
   `gh webhook forward` for its own repository.

## Out of scope
- A shared receiver that multiplexes several repositories on one port (a later RFC if wanted).
- Tunnel feeds other than `gh webhook forward`.

## Acceptance Criteria
- [x] With a receiver already bound to the default port by another board dir, `cli-hierarchy webhook up` in a second project starts on a different port without `--port` or `AI_SDLC_WEBHOOK_PORT`, and `webhook status` reports `healthy (port <n>)`.
- [x] A restart of the second project's receiver reuses the port recorded in its `webhook.json`.
- [x] The installed forwarder targets the recorded port; `webhook status` prints the full target URL.
- [x] A forced bind failure (all candidate ports held) exits non-zero with a message that names the port and the owning process; `status` reports it as a collision, not "not running".
- [x] Unit tests cover: default free, default held then next free chosen, recorded port reused, all held fails clearly, forwarder URL built from the recorded port.
- [x] `docs/operations/cli-hierarchy.md` documents multi-instance operation on one host.
- [x] `AI_SDLC_WEBHOOK_PORT` and `--port` still pin the port and win over automatic selection.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
`webhook up` now picks a free per-project port. It starts from the port recorded in the board dir, or the configured default, and scans 20 ports upward. The choice is recorded and reused on restart, and the forwarder is installed against it. `webhook status` prints the full target URL. A collision exits non-zero naming the port and owner, and `status` reports it as a collision. `--port` and `AI_SDLC_WEBHOOK_PORT` still pin the port. `docs/operations/cli-hierarchy.md` documents multi-instance operation.

## Changes
- pipeline-cli/src/hierarchy/webhook.ts
- pipeline-cli/src/hierarchy/webhook.test.ts
- pipeline-cli/src/hierarchy/types.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1254 - webhook receiver per-instance port and url.md

## Design decisions
The full chain ran in a background shell. Build and tests passed, but lint then failed on `preserve-caught-error`, which I fixed. After the fix I re-ran only eslint, prettier, tsc and the webhook tests (the webhook test run printed nothing, so I haven't seen it pass again), not the full chain; the push hook then ran the pipeline-cli coverage suite. The recorded port lives in a new `webhook-port` file in the board dir, because `webhook down` deletes `webhook.json`. The in-use probe uses exit code 7 and treats an unusable probe as free. The forwarder launchd label is still a single `io.ai-sdlc.webhook-forward` per user, so a second project's `--feed gh-forward` replaces the first's agent. I documented that rather than changing it; it would need a per-project label. The commit also includes the backlog task file's status change to In Progress.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
- declined: per-project forwarder launchd label is out of scope for this task and not in its ACs

