---
id: AISDLC-1207
title: 'webhook up manages the gh forwarder as a supervised agent'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy webhook
  - operator toil
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator question 2026-11-06: "Why do I need to keep restarting this, couldn't we just set up a daemon." Affected surface: `cli-hierarchy webhook up --feed gh-forward` (pipeline-cli/src/hierarchy/webhook.ts) and its docs.

The receiver (`webhook serve`) already runs detached and has stayed up for days. The feed, `gh webhook forward`, is a foreground `gh` process tied to the operator's terminal: it dies on terminal close, sleep or a network drop, and five decision records in two days (DEC-0374, 0376, 0377, 0379, 0382) are the same "webhook down, restart feed" loop. Two more failure shapes surfaced on 2026-11-06 while the operator set up a launchd agent by hand:

- The hook must be created with `--secret` equal to `AI_SDLC_WEBHOOK_SECRET`, or the receiver answers 401 to every delivery and health never recovers. Nothing in `webhook up` or the printed command says so.
- A forwarder that dies without a clean exit leaves its `cli` hook on the repository; the next start fails with `HTTP 422 Hook already exists`, and a KeepAlive supervisor crash-loops on it.
- `webhook.json` records a feed pid; after every supervised restart that pid is stale, so `webhook status` cannot tell whether the feed is alive.

The hand-installed agent (`~/Library/LaunchAgents/io.ai-sdlc.webhook-forward.plist`, label `io.ai-sdlc.webhook-forward`) is the interim; this task makes `webhook up` own it.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* Events are needed only while a hierarchy runs; polling exists as fallback (`accept-poll-only`). But every restart is operator toil and the dispatch tick burns gh quota polling (1700+ calls/hour). A supervised feed is cheaper than either.
2. *Delete.* Drop the `--feed-pid` registration as the liveness signal; it is wrong after the first restart.
3. *Simplify.* `webhook up --feed gh-forward` writes and loads a per-user launchd agent (macOS; a systemd user unit on Linux is a follow-up, print the command there) that runs `gh webhook forward ... --secret $AI_SDLC_WEBHOOK_SECRET --url ...` with `KeepAlive`. Before loading it, delete any existing `cli`-named hook on the repository whose config url is the GitHub forwarder endpoint (stale hooks from an unclean exit). `webhook.json` records the agent label; `webhook status` and `webhook-health` ask launchd (`launchctl print`) for liveness instead of a pid. `webhook down` unloads the agent (graceful exit removes the hook) and then deletes any leftover `cli` hook.
4. *Accelerate.* None.
5. *Automate.* Tests cover: plist content (secret and url present, KeepAlive true), stale-hook cleanup choosing only `cli` hooks at the forwarder endpoint (never the operator's other hooks), status reading the label, and the printed fallback on non-macOS.

The hook is created under the operator's gh login, so `webhook up` stays an operator-run command; it must never be invoked by an executor or from CI.

## Acceptance Criteria
- [ ] #1 `webhook up --feed gh-forward` installs and loads a launchd agent that runs the forwarder with `--secret` from `AI_SDLC_WEBHOOK_SECRET`; a missing secret is an error, not a silent 401.
- [ ] #2 Before loading, stale `cli` hooks at the forwarder endpoint are deleted; no other repository hook is touched (test with a fixture listing a non-cli hook).
- [ ] #3 `webhook status` reports the feed alive or dead from the agent label, not a recorded pid; `webhook down` unloads the agent and removes any leftover hook.
- [ ] #4 `docs/operations/cli-hierarchy.md` replaces the manual two-line forwarder recipe with the new behaviour and documents the non-macOS fallback.
