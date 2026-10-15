---
title: "Reviewer Independence"
description: "Where a review ran and why the implementer could not influence it."
---

Proof of Execution says a review ran. It does not say the review was produced by something the implementer could not influence. Reviewer independence is that second property, designed as its own tier with its own threat model, and anchored on infrastructure the coordinator process cannot reach.

> **RFCs:** [RFC-0046 — Attested Reviewer Independence](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0046-attested-reviewer-independence.md) · [RFC-0047 — Re-derivable Isolated Anchor](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md) · **Status:** both signed off; the `requiredTier` policy knob and the CI-key anchor have shipped · **Runbook:** [independence policy](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/independence-policy.md)

## Why a heuristic was not enough

The first attempt at this was a field on the attestation leaf, `verdictClass: independent | self-authored`, set by a same-machine check on the agent type and a marker file. It was honest about being a heuristic, and it kept accumulating patches as new ways to fool it turned up. The RFC freezes that field as legacy-read-only rather than amending it again.

The replacement is a tier the verifier can re-derive instead of a label the signer asserts.

## The three tiers

| Tier | What it claims | Can a determined same-machine coordinator forge it? |
|------|----------------|------------------------------------------------------|
| `none` | No claim. The review may have been self-authored. | Not applicable |
| `attested` | A heuristic signal says the reviewer was a separate agent. | Yes. Informational only, never load-bearing. |
| `isolated` | The review ran inside a sandbox boundary the coordinator does not control, and the attestation was signed by a CI-only key the coordinator does not hold. | No, by construction. |

An envelope's overall tier is the weakest tier across its reviewer leaves. By default the tier is surfaced and never blocks anything. A repository opts into enforcement with one line, `requiredTier: isolated`, and the same check runs whether the repository uses GitHub branch protection or a procedural ship flow.

## The forgery that shaped RFC-0047

The first implementation of the `isolated` tier anchored it on a provenance string that said "this ran in CI", signed with the operator's ordinary key. A three-reviewer reconcile returned a critical finding: the actor the tier is supposed to defend against is exactly the actor holding that key. The PR was held, not merged, and the anchor was redesigned in a dedicated RFC rather than patched under time pressure.

RFC-0047 resolves it with a signing identity the verifier can check independently: a CI-held key distinct from the operator's, with the verifier re-deriving the claim rather than trusting the field. The incident is written up in the RFC, including the reviewer finding that caught it.

## What this unlocks

- A repository can state, and have CI enforce, that nothing merges unless the review ran somewhere the implementer could not reach.
- Security teams get a tier they can put in a policy document, with a published definition of what each level does and does not resist.
- The framework's own history of getting this wrong once is part of the record, which is the point of a re-derivable design.

## Where to go next

- [Proof of Execution](./proof-of-execution.md) is the property this one builds on.
- [Zero-trust PR verification](./zero-trust-untrusted-pr-verification.md) supplies the sandbox and clean-room boundary that the `isolated` tier is anchored on.
