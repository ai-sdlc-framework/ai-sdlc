---
name: route-questions-via-planner
description: operator-dispatch must not ask the operator questions directly; route every decision to rfc-planner
metadata:
  type: feedback
---

As operator-dispatch, never put decision questions to the operator (no AskUserQuestion, no "your call" asks). Send them to rfc-planner with full background; the planner answers or escalates to the operator itself if important.

**Why:** the operator said on 2026-10-03: "I don't want direct questions from the operator dispatch, the rfc-planner can ask me questions directly if it's important."
**Violated 2026-10-04:** I opened an AskUserQuestion prompt about 721 overnight. It froze dispatch for hours until the planner dismissed it. NEVER open a blocking prompt to the operator, especially when he's away. The planner decides classes (a) and (b), and collects class (c) (legal, money, credentials, identity-only actions such as merging the release PR or closing or disarming a PR). The same goes for ending a status with a list of "decisions for you": route those to the planner instead.
**How to apply:** status updates to the operator are fine; questions go to rfc-planner (include full context, since its memory may be cleared). See [[operator-dispatch-handoff]].
