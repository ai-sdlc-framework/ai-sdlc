---
title: "Judgment Layer"
description: "A rung on the evaluation ladder between code and generative agents that answers closed-set questions cheaply."
---

A new rung on the evaluation ladder between code and generative agents. The judgment layer answers closed-set questions (pick one of N, rate on a rubric, yes or no) with a probability distribution, in one fast call, without generating text. It replaces the keyword and regex heuristics that used to stand in for semantic judgment, and it sits in front of the expensive agents as a cheap gate.

> **RFC:** [RFC-0049 — System One Judgment Layer](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0049-system-one-judgment-layer.md) · **Status:** Signed off; runtime, catalog, log, cache and the first judgment groups shipped October 2026, all in `shadow` · **Runbooks:** [judgment layer](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/judgment-layer.md) · [promotion](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/judgment-promotion.md) · [definition rules](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/judgment-definitions.md)

## Three outcomes, one of which is "do nothing"

Every judgment resolves to one of three outcomes:

- **act**: the judgment decided.
- **escalate**: the judgment is unsure, and the work goes to an operator or a generative model.
- **abstain**: the judgment declined. The caller does exactly what it did before the layer existed.

The layer does not write code, review code, merge anything or run on its own. Each call site asks one catalogued judgment. It is off unless a provider is configured.

## Where it is used

| Seam | Before | With the judgment layer |
|------|--------|--------------------------|
| Definition-of-Ready Stage B | Prose rubric scored by a generative agent | Judgment-first, with separate tighten and relax definitions |
| Review routing | Regex classifier picks the reviewer set | A judgment classifies what the diff touches and how risky each hunk is |
| Acceptance-criteria coverage | Not checked | Advisory judgment on whether the diff covers the criteria |
| Finding grounding | Not checked | Advisory judgment on whether a reviewer finding points at real code |
| Estimation class | Keyword heuristics | Judgment picks the class |
| Decision Catalog dimensions | Placeholder scorers | Production backend |

## Shadow first, promote on evidence

Every judgment ships in `shadow`: the call is made and logged, its answer is ignored, and the existing path decides. Promotion to `enforce` happens one judgment at a time, and the bar depends on what a wrong answer could do:

| Risk class | What a wrong answer does | Promotion bar |
|------------|--------------------------|---------------|
| `seam` | Fills a seam that had nothing before | 50 labelled items, 90% act-band precision, or a documented operator override |
| `tighten` | Adds scrutiny | Same as seam |
| `relax` | Reduces review of code that merges | 50 rows from the findings ledger, 95% precision, and **no override path** |

The runtime checks the bar in code. A promotion record whose numbers do not clear the bar leaves the judgment in shadow. On work that is not from the trusted backlog, every judgment is treated as tighten-only, so a steered answer cannot wave anything through.

## Capability liveness

The RFC also closes a process gap: several of these seams had been typed and specified months earlier and never wired, and nothing noticed. Every optional capability now reports whether it ran live, in shadow or degraded. The doctor command and the RFC lifecycle gate read that record, and an RFC can no longer be promoted to Implemented without runtime evidence.

## Providers

The layer is provider-neutral. The primary adapter is Jev, typesafe.ai's System One model. A generic OpenAI-compatible adapter ships alongside it for adopters who cannot take on a new vendor; it runs in shadow only because it is uncalibrated.

## Where to go next

- [Staged review](./staged-review.md) is the first large consumer of the judgment layer.
- [Definition-of-Ready gate](./dor-gate.md) describes the Stage A/B split the judgment layer now fronts.
