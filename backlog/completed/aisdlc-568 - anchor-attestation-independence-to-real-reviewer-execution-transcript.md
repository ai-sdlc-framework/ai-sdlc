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

- [ ] **Deferred to [[aisdlc-570]] (DEC-0012 opt-a, not this task's shipped
      scope).** Transcript leaf hashes the reviewer subagent's real
      auto-captured execution JSONL (not a coordinator-writable summary
      file); a coordinator that only writes a summary cannot produce a
      passing independent-tier leaf. The escalated decision DEC-0012
      (`node pipeline-cli/bin/cli-decisions.mjs show DEC-0012`) was resolved
      to **opt-b**, not opt-a — opt-a requires locating a subagent's own
      harness transcript deterministically per invocation, which varies by
      harness/CLI version and does not exist for CI/headless dispatch. What
      this task hashes into the leaf is UNCHANGED from before AISDLC-568:
      the Bash-written `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl` file.
      [[aisdlc-570]] tracks the opt-a investigation + implementation as a
      standalone follow-up.
- [x] A coordinator/self-authored attestation is recorded and verified as a
      distinct lower-trust verdict class, visibly not equivalent to an
      independent-reviewer verdict. **Shipped (DEC-0012 opt-b):** every v6
      transcript leaf now carries `verdictClass: 'independent' | 'self-authored'`
      (`pipeline-cli/src/attestation/verdict-class.ts`), derived from whether a
      real `SubagentStart` harness hook fired around the time the transcript
      was written (`ai-sdlc-plugin/hooks/subagent-start.js` writes a
      `.ai-sdlc/subagent-sessions/<agent-id>.json` marker on every firing — a
      signal only the harness's own `Agent`/`Task` dispatch can produce, never
      a coordinator writing files/text alone). `cli-attestation emit-leaf`
      consumes an unconsumed, in-window marker to classify `independent`;
      absence/staleness/malformed markers fail safe to `self-authored`. The
      verifier (`verifyV6Envelope`) cross-checks the envelope's declared class
      against the on-disk leaf's Merkle-proved value (rejecting mismatches as
      tampering) and surfaces a per-leaf breakdown + weakest-link
      `overallVerdictClass`. **Honest limit:** this is a same-process/session
      heuristic, not a cryptographic proof — it correctly downgrades the
      common lazy-self-review case (coordinator runs the reviewer's Bash
      steps itself, no subagent spawned) but does not stop a *deliberately
      adversarial* coordinator from also fabricating the marker file, since
      it already has the same repo Bash/Write access. Closing that gap is
      exactly the opt-a follow-up above.
- [x] Claim wording (docs + any emitted human-readable summaries) states the true
      guarantee and does not assert independence where it isn't structurally
      anchored. (Shipped in PR #980, AISDLC-568 part 1; extended in this PR to
      cover the new `verdictClass` field's honest scope across RFC-0042, the
      whitepaper, transcript-management.md, and
      zero-trust-untrusted-pr-verification.md.)
- [x] Hermetic tests: (a) independent-reviewer path produces an independent-tier
      leaf; (b) self-authored path is rejected or downgraded to the lower-trust
      class; (c) verifier surfaces the trust class. Covered by
      `pipeline-cli/src/attestation/verdict-class.test.ts`,
      `pipeline-cli/src/cli/attestation.test.ts` ("emit-leaf — verdictClass
      detection"), `scripts/verify-attestation.test.mjs`
      ("verifyV6Envelope (AISDLC-568 — verdictClass)"), and
      `ai-sdlc-plugin/hooks/subagent-start.test.mjs` ("AISDLC-568 marker
      writing").

**Status: DEC-0012 opt-b shipped in full (AC#2, AC#3, AC#4 above).** AC#1
(opt-a — binding the leaf to the reviewer subagent's own harness-captured
execution transcript) was, per DEC-0012's own resolution, always the
harness-coupled follow-up rather than part of this task's immediate scope —
it is now tracked standalone as [[aisdlc-570]].
