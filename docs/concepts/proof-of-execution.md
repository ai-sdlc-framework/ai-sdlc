---
title: "Proof of Execution"
description: "Evidence recorded outside the branch that a real review ran against the exact diff being merged."
---

Evidence that a real review ran against the exact diff being merged. Not a green check that says a workflow finished. A verdict record written by the pipeline, held outside the branch in `refs/ai-sdlc/verdicts/*`, that the merge gate reads before a PR can land.

> **RFC:** [RFC-0042 — Proof-of-Execution Attestation via In-Repo Merkle Transcripts](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0042-proof-of-execution-attestation.md) · **Status:** Implemented, then replaced by the review verdict record ([RFC-0061](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md)); the signed v6 envelope is retired · **White paper:** [Proof of Execution](../whitepapers/proof-of-execution.md)

## The gap it closes

Most AI-assisted pipelines have already taken a shortcut: when a local reviewer marks work approved, the expensive CI review is skipped. That leaves a system in which the agent that wrote the code can also write the JSON file that says the reviewer approved it. The merge gate accepts the file. Nobody checks whether the reviewer ran.

Proof of Execution makes the absence of a review visible. If a reviewer never ran, there is no reviewer entry in the verdict record. If the record is missing or does not cover the diff, the gate reports `no-record`, `coverage-short` or `subject-mismatch` and the PR does not merge.

## How it works

1. Each reviewer subagent runs against the PR's diff. Its role, verdict and findings, and the diff it looked at, go into a verdict record.
2. The pipeline pushes the record to `refs/ai-sdlc/verdicts/<headSha>` before the PR leaves draft. Nothing is committed to the branch and no key signs anything.
3. The `verdict-check` job in CI reads the record for the PR head and checks the subject, the coverage and the independence tier, then posts the `ai-sdlc/attestation` status.
4. A rebase needs no re-sign. When the reviewed diff replays cleanly onto the new base, the gate carries the earlier approved record forward; a changed or conflicting replay needs a new review. The mechanics and the trust claim (error-resistant, not forgery-resistant) are in [attestation-reference](../operations/attestation-reference.md).

## What it does and does not prove

| Claim | Covered? |
|-------|----------|
| A reviewer process ran against this exact diff | Yes |
| The verdict in the record is the verdict that process produced | Yes, as an audit trail; only the pipeline may write it |
| The attestation was not reused from another diff | Yes, the record binds the head and tree, and carry-forward needs a clean replay |
| The reviewer was independent of the agent that wrote the code | No. That is a separate property, see [Reviewer independence](./reviewer-independence.md) |
| The reviewer was a specific person or model | No. Identity is out of scope |

Being explicit about the second half of that table is deliberate. The attestation is only as useful as the claims it refuses to make.

## What this unlocks

- **Audit teams** get a record per merge that answers "what reviewed this, and did it actually run" without reading CI logs.
- **Maintainers** can keep the cost-saving shortcut (skip CI review when a local review is attested) without losing the guarantee the shortcut used to break.
- **Regulated adopters** have a primitive that maps onto SOC 2 change-management evidence and ISO 42001 record-keeping, with zero per-PR cost and no third-party transparency service.

## Where to go next

- The [white paper](../whitepapers/proof-of-execution.md) has the threat model and the comparison with Sigstore, in-toto and SLSA.
- [Zero-trust PR verification](./zero-trust-untrusted-pr-verification.md) shows how the verdict writer moves into a clean room when the contributor is untrusted.
- [Reviewer independence](./reviewer-independence.md) is the companion property that Proof of Execution deliberately leaves to a separate RFC.
