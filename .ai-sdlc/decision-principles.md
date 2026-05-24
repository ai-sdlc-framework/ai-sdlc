# Decision Principles

Seven durable principles that guide every Stage C recommendation. These
mirror the eight RFC-0035 §15.1 design patterns codified during the
2026-05-15 operator walkthrough and are the basis for Stage C's
prompt-anchoring.

## 1. Deterministic-First

The deterministic Stage A ladder (schema validity, blast radius,
reference resolution, decision-tree depth, capacity arithmetic,
reversibility, duplicate detection) resolves ~60% of decisions without
any rubric or LLM call. Stage B's structural rubric resolves another
~35% with a small set of deterministic dimensions. Stage C fires only
when Stage B's composite score lands in the mid-band [0.4, 0.7] —
outside that band the rubric is already certain enough.

When Stage C fires, prefer the recommendation Stage B's rubric scores
already suggest. The LLM's job is to break ties, not to overrule the
rubric.

## 2. Respect Fatigue

Operators have bounded decision throughput per day. When the operator
declares fatigue (`ai-sdlc operator-state fatigue --on`) OR the
framework infers it (override-rate > 50% in the last hour, opt-in
only), Stage C continues to fire but auto-applies are deferred to the
next day. Decisions made under fatigue are flagged for re-review.

Never queue a 30-minute architectural decision after the operator has
already processed 20 small decisions in a session — the override rate
will be artificially high.

## 3. Surface Counter-Arguments by Default

A recommendation without a counter-argument is a sales pitch, not a
decision support. Stage C SHOULD surface the strongest steel-manned
objection to the recommendation (Phase 6 / OQ-9). Even when the
recommendation is highly confident, an explicit counter-argument
prevents the operator from rubber-stamping without examining trade-offs.

Phase 5 ships the recommendation skeleton; Phase 6 enriches with
counter-arguments + alternatives + sub-decisions.

## 4. Explain Auto-Decisions in the Digest

Every framework auto-apply is visible in the operator's daily digest
(default: `overridden-only` mode — operators see auto-applies they
later overrode; `all` mode for compliance orgs; `anomalous` mode for
calibration-driven review). The digest is the operator's primary
calibration loop — it must show WHY the framework picked an option,
not just THAT it did.

The `operator-answered` event with `by: 'framework'` is the
machine-readable record; the digest renders the linked
`stage-c-completed` event's rationale alongside.

## 5. Never Auto-Apply One-Way Decisions

`decision.spec.reversible === false` ALWAYS blocks auto-apply. This
applies even when Stage C confidence is 1.0. Irreversible decisions
require explicit operator confirm; the LLM may recommend, but it may
never decide.

Examples of one-way decisions: db migrations, public API breaks, merge
conflict resolutions, schema deletions, data migrations. Pattern-match
against `IRREVERSIBLE_PATTERNS` in `stage-a.ts` for the default list;
per-decision override via `decision.spec.reversible: false`.

## 6. Compose, Don't Duplicate

Stage C composes with the RFC-0024 shared classifier substrate. The
substrate owns the prompt template, the LLM invoker abstraction, the
corpus storage, the override-window helpers, and the silence-as-
positive sweeper. Stage C wraps the substrate to translate Decision-
record shapes to the substrate's `ClassifierInput` shape and back —
nothing more.

When a future surface (e.g. PR review classifier, RFC OQ classifier)
needs LLM evaluation, it adds a task type to the substrate, not a
parallel substrate.

## 7. Calibration is Operator-Driven

The Stage C runner does NOT auto-promote exemplars to calibration
anchors. The substrate corpus captures every (input, classification,
operator-correction) tuple; the aggregator surfaces clusters that meet
the OQ-11 promotion threshold (≥ 3 consistent overrides); operators
explicitly promote via `cli-decisions corpus tag-anchor` (Phase 9 — not
in this PR, but the candidate-detection ships now).

Auto-promotion is anchor poisoning waiting to happen. The 3-event
threshold is honest about needing repeated signal before nudging
prompts; the operator-confirm gate is honest about the cost of a wrong
anchor on future decisions.
