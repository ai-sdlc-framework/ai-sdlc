# Fail-soft at the adopter boundary

**Principle:** A gate that protects an *artifact's integrity* belongs at the
boundary that owns that artifact — never as a step that can hard-block an
adopter's core loop. When attribution/provenance metadata is missing, **degrade
the metadata, keep the loop running**; enforce trust where the trust actually
lives.

## Why this exists

This principle is the generalized lesson of the 0.21.0 adopter-brick
([post-mortem](../audits/2026-09-18-0.21.0-adopter-brick.md)). A change made the
reviewer subagent **refuse to review** when it could not attribute the run to a
task. The intent was sound — protect the attestation evidence chain — but the
gate was placed in the wrong layer: it blocked the adopter's *core loop* (get a
review) to protect an *artifact* (the transcript) that the loop does not depend
on. In any adopter repo, where the attribution wiring is absent by default, this
bricked everything.

## The rule

For any gate that enforces a trust/integrity property, ask two questions:

1. **What does this gate protect?** (An artifact: an attestation, a signed
   envelope, a provenance record.)
2. **What does it block when it fails?** (Ideally: only the production of that
   artifact. Never: the adopter's ability to do their core work.)

If the answers diverge — the gate protects an artifact but blocks the core loop —
**move the gate to the artifact boundary.**

### Concretely

- **Reviewers always analyze.** A reviewer that cannot attribute its run still
  reads the diff and produces findings. Missing attribution degrades the
  *transcript* (a unique unattributed id, so nothing collides), it does not stop
  the review.
- **The signer is the trust boundary.** Attestation integrity is enforced where
  the envelope is signed and verified (the operator's key over committed
  transcript leaves), not by refusing upstream work. A coordinator that wants a
  stricter policy adds it at the signer/verifier, where an adopter's core loop is
  not on the line.
- **Fail-soft with teeth, not fail-soft with a shrug.** Degrading gracefully
  does not mean discarding the concern. The 0.21.0 fix preserved the original
  anti-collision property (unique per-run ids) *while* keeping the loop alive —
  that is the bar: keep the safety property, move where it's enforced.

## When fail-CLOSED is still correct

Fail-closed remains right for a **genuine misconfiguration of a present input**,
as opposed to an *absent* one. Example: a `.active-task` sentinel that contains a
path-traversal value (`../evil`) is a real misconfiguration with a real security
risk, so the resolver still hard-refuses it. The distinction is:

- **Input absent** (adopter has no attribution wiring) → **fail soft**, degrade
  the metadata, keep going.
- **Input present but malformed/unsafe** (path traversal, alias risk) → **fail
  closed**, refuse.

## Checklist for a new adopter-facing gate

- [ ] Does failure block the adopter's core loop, or only an artifact? If the
      former, can the enforcement move to the artifact boundary?
- [ ] Is the failure mode *absent input* (→ soft) or *unsafe present input*
      (→ closed)? Handle them differently.
- [ ] If soft, is the degraded path still safe (no shared-state collision, no
      silent loss of a real safety property)?
- [ ] Is there a test that exercises the **adopter environment** where the input
      is absent — not only the in-repo happy path? (See
      [CONTRIBUTING.md → Changing a Shared Surface](../../CONTRIBUTING.md#changing-a-shared-surface--test-the-boundary-not-just-the-unit).)

## Audit of current adopter-facing gates

At the time of writing (2026-09-18), a review of gates that run in an adopter's
critical path found:

- **Reviewer transcript attribution** — was fail-closed on absent input
  (the 0.21.0 defect); now fail-soft-unique (AISDLC-623). ✅ compliant.
- **Attestation sign / verify** — enforced at the signer/verifier (the correct
  artifact boundary), not in the adopter's review loop. ✅ compliant.
- **`doctor`** — advisory (WARN), never blocks. ✅ compliant.

No other adopter-critical-path gate was found to fail-closed on merely-absent
input. Re-run this audit whenever a new gate is added that can execute in an
adopter repo.
