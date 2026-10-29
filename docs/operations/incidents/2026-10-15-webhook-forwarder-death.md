# Webhook forwarder death

## What happened

The laptop-local webhook receiver for the RFC-0054 event path lost its GitHub-to-localhost hop when the forwarder process died, so GitHub events stopped reaching the receiver.

## Impact

Event-driven wakes did not fire. Dispatch fell back to the reconcile poller, which delayed reaction to PR state changes.

## Timeline (UTC)

- 2026-10-15: AISDLC-880 shipped with the forwarder choice made in an ops doc.
- 2026-10-15 17:38: DEC-0235 opened for RFC-0054 OQ-15 (how GitHub reaches the receiver) and answered the same minute.
- 2026-10-15: implementation filed as AISDLC-918.

## Ruling and who made it

DEC-0235, operator, option `gh-forward`: `gh webhook forward` owned by `cli-hierarchy up/down`; the forwarder is a config value, tunnels are external; the poller backstops dropped events.

## Root cause

Nothing owned the forwarder's lifetime, and nothing reported its death, so the failure was silent.

## Follow-up

AISDLC-918 implements the owned forwarder. A doctor check for a dead forwarder is not filed (see ledger).
