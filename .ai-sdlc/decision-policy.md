# AI-SDLC Decision Policy

This document provides calibration context for the framework's Decision
Catalog (RFC-0035) Stage C LLM evaluator. The Stage C runner reads this
policy, the `decision-principles.md` durable principles, and the
`decision-exemplars.yaml` labelled exemplars before issuing a
recommendation.

## Golden rule

**When in doubt, defer to the operator.**

The Decision Catalog's first contract (G0) is that the pipeline NEVER
halts on a decision. The Stage C LLM's job is to surface a
recommendation the operator can quickly accept or override — NOT to make
load-bearing decisions on the operator's behalf. Confidence below the
threshold (default 0.7) routes to the operator with the recommendation
visible as a suggestion. Confidence at or above the threshold AND a
reversible decision auto-applies with a 24h override window per
OQ-3 / OQ-12.

## Routing and answer policy

- **Reversible + high confidence** — auto-apply; operator sees in the
  digest with 24h override window.
- **Reversible + mid-band confidence** — surface as suggestion;
  operator confirms or overrides.
- **Reversible + low confidence** — surface options + research
  suggestion; no recommendation pre-filled.
- **Irreversible (`reversible: false`)** — NEVER auto-apply. Always
  surface to operator with the recommendation as a suggestion. The
  override-window pattern is reserved for reversible decisions where
  the operator can roll back the auto-applied choice within the window.

## Confidence thresholds

| Composite confidence | Action |
|---|---|
| ≥ 0.8 + reversible + LLM-eligible | Auto-decide; digest visible |
| ≥ 0.7 + reversible + LLM-eligible | Auto-decide (default threshold) |
| 0.5 – 0.7 | Surface with recommendation + counter-arguments; operator decides |
| < 0.5 | Surface options + research suggestions, no recommendation |

The 0.7 default threshold is configurable per-org via
`decisions-config.yaml: stageCConfidenceThreshold`. Confidence is the
LLM's self-reported value — calibrate against the exemplar bank rather
than treating model-reported confidence as ground truth.

## Calibration loop

Every override of a framework auto-apply is a calibration signal. The
substrate's `recordOperatorOverride()` flips the corresponding corpus
entry's polarity to `negative` and captures the operator's
override-classification. The shared corpus aggregator
(`cli-decisions corpus aggregate`) surfaces clusters of negative
exemplars that converge on the same operator-correction; operators
promote those clusters to "calibration anchors" via the OQ-11
promotion path (≥ 3 consistent overrides per RFC-0035 OQ-11).

Silence within the override window is a positive exemplar — the
substrate's `resolveSilenceAsPositive()` sweeper flips pending entries
older than the window to `positive`.

## Override-window length

Default: 24 hours (per OQ-3 resolution). Configurable per-org via
`decisions-config.yaml: overrideWindowHours`. The window is global to
the substrate (capture + DoR + decisions share one timeout) — change it
intentionally; operators don't want to memorise two different override
windows for different surfaces.

## When the framework should NOT auto-apply

The framework refuses to auto-apply when ANY of:

- `decision.spec.reversible === false` (irreversible)
- Stage C confidence below the configured threshold
- LLM response not a valid option-id (substrate fall-open)
- LLM invoker unavailable (no API key, network error, budget exhausted)

In every refusal case the recommendation is still visible in the
operator's queue as a suggestion. The framework never silently swallows
a recommendation — surfacing is mandatory; auto-applying is conditional.

## Compositional contract

The Stage C runner composes with the RFC-0024 shared classifier
substrate (`pipeline-cli/src/classifier/substrate/`). One Haiku-class
classifier serves five task types (capture triage, capture severity, PR-
comment-is-capture, DoR new-concern, decision-recommendation); one
calibration corpus spans all of them; one override-window setting
applies to all. Do not duplicate prompt templates, corpus storage, or
override-window logic in the Decision Catalog — compose with the
substrate.
