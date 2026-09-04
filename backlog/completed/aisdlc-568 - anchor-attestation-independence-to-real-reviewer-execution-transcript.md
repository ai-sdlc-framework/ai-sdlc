---
id: aisdlc-568
title: >-
  Anchor attestation independence to the reviewer's real execution transcript +
  a lower-trust self-review verdict class
status: Done
priority: high
labels:
  - attestation
  - proof-of-execution
  - adoption
drift_status: flagged
drift_checked: '2026-09-04'
drift_log:
  - date: '2026-09-04'
    type: ref-deleted
    detail: 'Referenced file no longer exists: AISDLC-566'
    resolution: flagged
  - date: '2026-09-04'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
---

## Description

From the Proof-of-Execution consumer-repo investigation (external report at GitHub
issue #976). AISDLC-554 restored the signer's **reachability** in consumer repos,
and [[aisdlc-566]] covers the missing consumer-runnable **verifier**. This task
covers the remaining, deeper gap: **independence is not structurally anchored** —
even with a valid signature, nothing distinguishes "an independent reviewing
actor" from "the coordinator/author that also made the ship decision."

Confirmed at `main`: the signature is over the Merkle root only, using
`~/.ai-sdlc/signing-key.pem` (`sign-attestation.mjs`, `pipeline-cli/src/attestation/sign-v6.ts`).
Any process with a repo checkout + read access to that key can author a reviewer
transcript file and sign it. Forge-resistance (transcript ≈ cost of real review)
does **not** stop an *expensive self-review*: the coordinator paying full cost,
running the review itself, and recording it as "the reviewer."

## Scope

1. **Bind the leaf to the reviewer's real, auto-captured execution transcript**,
   not a hand-written summary file. The agent harness already emits a full
   per-subagent execution JSONL (prompt, tool calls, outputs). Hash *that*
   artifact into the leaf so the forgery floor becomes "actually spawn and run an
   independent reviewer subagent," which a coordinator cannot fake by writing a
   file. (This is the closest thing to true PoE achievable on a single machine.)
2. **Represent a coordinator/self-authored attestation as a distinct, lower-trust
   verdict class** rather than silently equivalent to an independent review, so an
   honest-wording configuration is enforceable and a self-review is visibly not
   independent.
3. **Correct the claim wording** everywhere to what is actually guaranteed:
   "records that a real review ran against this exact code state by a process with
   repo access; does NOT by itself prove reviewer identity or independence" —
   unless/until (1) is in place.

Composes with the operator-signs-root anchor and the consumer-verifier work
([[aisdlc-566]]); overlaps the enforcement-gap tasks [[aisdlc-560]],
[[aisdlc-561]], [[aisdlc-562]] (init installs artifacts without enforcement;
SessionStart claims policy active when nothing enforces it; never write
unattributable transcripts under `unknown`).

## Acceptance Criteria

- [ ] Transcript leaf hashes the reviewer subagent's real auto-captured execution
      JSONL (not a coordinator-writable summary file); a coordinator that only
      writes a summary cannot produce a passing independent-tier leaf.
- [ ] A coordinator/self-authored attestation is recorded and verified as a
      distinct lower-trust verdict class, visibly not equivalent to an
      independent-reviewer verdict.
- [ ] Claim wording (docs + any emitted human-readable summaries) states the true
      guarantee and does not assert independence where it isn't structurally
      anchored.
- [ ] Hermetic tests: (a) independent-reviewer path produces an independent-tier
      leaf; (b) self-authored path is rejected or downgraded to the lower-trust
      class; (c) verifier surfaces the trust class.
