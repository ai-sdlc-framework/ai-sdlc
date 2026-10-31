---
name: stability-before-unsupervised-spend
description: Operator 2026-10-14 — no watchdog or any unsupervised-spend automation until token burn is under control; deterministic code first, Qwen 27B (opencode) or JEV for low-stakes decisions, strong models only where thinking is required
metadata:
  type: feedback
---

Operator (2026-10-14, after the 24h drain review): do NOT build a watchdog that relaunches
or drives sessions unsupervised. While he is away (asleep) an uncleared context window
or a stuck loop could burn the whole weekly token budget. Stability first; unsupervised
operation comes later, once burn is controlled and shipping is reliable.

Direction for execute and dispatch: run them on deterministic code. Where a step needs
judgment, break it into smaller chunks so that most of it is deterministic, and route the
remaining low-stakes decisions to a cheap tier: the opencode Qwen3 27B model, or JEV.
Reserve Sonnet/Opus for the parts that need real thinking power.

**Why:** a watchdog that spends tokens while nobody watches is the exact failure he fears;
the win is making the pipeline need less judgment, not making it wake more agents.

**How to apply:** when ranking fixes, prefer (1) zero-token deterministic fixes (GitHub
settings, CLI code, prompt rendering), (2) alert-only monitoring that pages the operator
and spends nothing, (3) cheap-tier decisions for known low-stakes shapes. Never propose
relaunch-on-stall automation now. Extends [[feedback_automation_ladder]] and
[[feedback_priority_velocity_and_token_cost]].
