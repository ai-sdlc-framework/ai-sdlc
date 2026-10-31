---
name: codex-quota-standing-reenter
description: planner 2026-10-21 standing rule until 2026-11-19: reenter Codex-quota fake-CRITICAL iterate-needed verdicts yourself, no ping
metadata:
  type: project
---

Planner standing rule, until 2026-11-19 (Codex quota out): an iterate-needed verdict whose ONLY blocking finding is the Codex quota fake CRITICAL is reentered by dispatch as a review-stage resume, without pinging the planner. Note text: "export AI_SDLC_REVIEWER_HARNESS=claude before next-step; Claude-native reviewers, sign, push, flip ready, no developer". Any other finding still routes to the planner. Example: AISDLC-999 / #1817.

**Why:** codex reviewers return a fake CRITICAL on usage-limit, wasting a round; AISDLC-1003 (harness default from model-routing.yaml) is being filed to stop it. See [[feedback_codex_quota_fallback]].

**How to apply:** `cli-dispatch.mjs reenter <pr> --board-dir "$BOARD_DIR" --note "<text>"` (flags after the PR number). Authority is the planner's message; drop this rule after 2026-11-19 or once AISDLC-1003 lands.
