---
name: feedback_release_pr_arm_is_standing
description: operator 2026-10-17 — the release-please PR waits for the brief it is named for to drain; green is not the trigger; planner reports the gap, never arms on its own
metadata:
  type: feedback
---

CORRECTED 2026-10-17 02:00Z. The 01:20Z version of this note said "arm the release PR on green without asking". That was a loosening the operator never gave. Release 0.30.0 (#1592) landed while the brief `token-reduction-critical-path` still had 884/885 and 873 open; the operator's instruction was "tell me to release once the brief is complete".

**Why:** a plugin release is what carries hook/command/prompt changes to executor sessions; one that ships before the brief named "to release" drains wastes the release cycle (same failure as [[feedback_release_waits_for_named_unblocker]], 0.25.0 / #1305).

**How to apply:** when a brief is titled "... to release", the release-please PR is gated on EVERY task in its `dispatchBrief` block having a `done/` verdict with a landed PR, not on "#N landed" or on green checks. The planner checks the brief, then tells the operator "brief drained, release #N is ready"; the operator says release; only then the merge-if-eligible CLI with the release source kind and `--arm`. A green release PR with the brief still open is reported as "waiting on <tasks>", never armed. Dispatch never arms the release source kind on its own. See [[feedback_prs_auto_armed_never_ask_to_merge]] for ordinary backlog PRs, which this does not change.
