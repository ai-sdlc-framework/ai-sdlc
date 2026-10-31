---
name: project-884-verdict-rewrite-pending
description: Pending dispatch action after #1647 is ready and armed, rewrite AISDLC-884 verdict failed to success so AISDLC-885 is released
metadata:
  type: project
---

Planner 2026-10-15 (GraphQL bucket resets 01:51Z): leave #1647 to mark-ready, do not flip it by hand.

**Why:** AISDLC-884 has a `failed` verdict although the work is done (PR 1647 draft, reviewers approved, attestation signed). AISDLC-885 is `after: 884` and stays held forever while that verdict is failed.

**How to apply:** each tick, check #1647 (once the rate limit allows). When it is ready AND armed: `cli-dispatch.mjs remove-verdict --from failed` for AISDLC-884, then `complete` / write a success verdict with pr 1647 (all with `--board-dir`, `--worker "$MY_NAME"`). Delete this memory after it is done. Do not wait on it while the PR is still draft.
