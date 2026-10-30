# PR head frozen on GitHub

## What happened

A PR's head SHA on GitHub did not advance after a successful push, so checks, reviews and the attestation targeted a stale commit.

## Impact

`ai-sdlc/pr-ready` evaluated the old head; the PR could not turn green or merge until the head moved.

## Timeline (UTC)

- 2026-10-16: head observed stale after a push while the branch ref on the remote was current.
- Recovery followed [`../pr-unstick.md`](../pr-unstick.md).

## Ruling and who made it

No decision record on `main` rules this incident; recovery used the existing unstick runbook. If a ruling is later recorded, add its id here.

## Root cause

Not established. GitHub did not update the PR head from the branch ref; consistent with GitHub-side sync lag under load.

## Follow-up

None filed yet. Detection of a head that lags its branch ref is a candidate doctor check (see ledger).
