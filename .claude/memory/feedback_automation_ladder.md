---
name: automation-ladder
description: Operator rule 2026-10-13 — deterministic first, structural second, cheap decision model (JEV) third, haiku tightly scoped fourth, strong model only to plan and synthesize; minimise prose automations
metadata:
  type: feedback
---

Operator rule (Dominique, 2026-10-13, for RFC-0054 and every automation after it):

1. **Deterministic** automations first (code, git/gh state, tests; no model).
2. **Structural** second (state machine / schema over structured data; no model).
3. Only if an LLM is needed: a **cheap decision model like JEV** — bounded classification, fixed labels.
4. If JEV lacks context or as its fallback: **haiku with a tightly scoped prompt**, parameters = the structural automation's data, fixed output schema.
5. A **strong thinking model only plans** what a cheaper model executes, the cheaper model executes, the strong model **synthesizes** — the review-planner → review-executor (haiku) → review-synthesizer pattern. Never a strong model executing directly.

Keep prose automations to a minimum, with tightly scoped parameters; every prose automation declares its rung, input schema, output schema and bounds.

**Why:** cost and determinism — the 2026-10-13 PR-drain showed most stalls needed rung 0/1 actions (flip ready, arm, rebase, requeue) that were instead routed through chat rulings and prose notes. See [[feedback_five_step_production_algorithm]], [[feedback_subagent_model_selection]], [[feedback_priority_velocity_and_token_cost]].

**How to apply:** when designing or filing any automation (RFC section, task Fix, agent frontmatter), name the rung and justify why the rung below cannot decide; reclassify existing prose steps downward wherever structured data suffices.
