---
name: velocity-first-governance-rule
description: DEC-0048: every new hook, gate, refusal, required check or default must justify itself on velocity, and none may leave work blocked on a human
metadata:
  type: feedback
---

DEC-0048 is the operator's standing rule, given 2026-10-04 and codified by AISDLC-711. Velocity and throughput come first. Scrutinise every new governance rule for why it is needed and what it costs in velocity. No rule may leave work blocked on human intervention.

Every dispatch brief and reviewer brief for a task that adds a hook, gate, refusal, required check or config default must carry these four requirements:
1. The PR body has a "Velocity impact" section for each new rule. It states the harm the rule prevents, the documented workflows it touches, and how often it fires on the happy path in a fresh adopter repo (the answer must be "never"). It also states what the agent does when the rule refuses it.
2. No refusal may end in "ask the operator". Each names a step an agent can take: a sanctioned command, a config key and value, or escalation to the dispatch or planner session. A rule whose only exit is a human is a MAJOR finding, except for legal, money and credentials.
3. Defaults let the documented workflow run with nothing configured. Stricter values are opt-in.
4. When a security finding asks for a new hard block, weigh it against velocity. Prefer the narrowest matcher, detect-and-report, or a sanctioned path. If the two can't be reconciled, send it to rfc-planner for a ruling instead of adding the block.

**Why:** On 2026-10-03 and 2026-10-04, gates such as the lease push, the merge path and the CLAUDE.md edits kept stopping work until the operator stepped in.

**How to apply:** Put these four requirements into the brief of every dispatch that adds a control. That covers 705, 709 and 710 when they are dispatched. 684, 702, 703, 694 and 667 (#1191) were already told on 2026-10-04. Existing controls are not relaxed. Related: [[route-questions-via-planner]], [[operator-dispatch-handoff]].
