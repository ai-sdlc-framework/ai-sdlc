---
title: "Proof of Execution"
description: "Signed, tamper-evident evidence that a real review ran against the exact diff being merged."
---

Signed, tamper-evident evidence that a real review ran against the exact diff being merged. Not a green check that says a workflow finished. A Merkle root over the reviewers' own transcripts, signed by the operator, committed next to the code, and verifiable years later against any historical commit.

> **RFC:** [RFC-0042 — Proof-of-Execution Attestation via In-Repo Merkle Transcripts](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0042-proof-of-execution-attestation.md) · **Status:** Implemented (the v6 attestation envelope is the default) · **White paper:** [Proof of Execution](../whitepapers/proof-of-execution.md)

## The gap it closes

Most AI-assisted pipelines have already taken a shortcut: when a local reviewer marks work approved, the expensive CI review is skipped. That leaves a system in which the agent that wrote the code can also write the JSON file that says the reviewer approved it. The merge gate accepts the file. Nobody checks whether the reviewer ran.

Proof of Execution makes the absence of a review visible. If a reviewer never ran, there is no transcript. If there is no transcript, there is no leaf in the Merkle tree. If the leaf is missing, the root does not match and the envelope does not verify.

## How it works

1. Each reviewer subagent runs with transcript capture on. The transcript is hashed and emitted as a leaf, with the reviewer role, the verdict and the content hash of the diff it looked at.
2. The leaves are combined into a Merkle root. The root, the subject commit and the leaf index go into a DSSE envelope.
3. The operator's ed25519 key signs the envelope. The envelope is committed in the repository under the attestations directory.
4. CI recomputes the root from the committed leaves and checks the signature. The check is patch-scoped, so a rebase that does not touch the reviewed files does not invalidate the attestation.

## What it does and does not prove

| Claim | Covered? |
|-------|----------|
| A reviewer process ran against this exact diff | Yes |
| The verdict in the envelope is the verdict that process produced | Yes |
| The attestation was not reused from another diff | Yes, the root binds the content hash |
| The reviewer was independent of the agent that wrote the code | No. That is a separate property, see [Reviewer independence](./reviewer-independence.md) |
| The reviewer was a specific person or model | No. Identity is out of scope |

Being explicit about the second half of that table is deliberate. The attestation is only as useful as the claims it refuses to make.

## What this unlocks

- **Audit teams** get a cryptographic record per merge that answers "what reviewed this, and did it actually run" without reading CI logs.
- **Maintainers** can keep the cost-saving shortcut (skip CI review when a local review is attested) without losing the guarantee the shortcut used to break.
- **Regulated adopters** have a primitive that maps onto SOC 2 change-management evidence and ISO 42001 record-keeping, with zero per-PR cost and no third-party transparency service.

## Where to go next

- The [white paper](../whitepapers/proof-of-execution.md) has the threat model and the comparison with Sigstore, in-toto and SLSA.
- [Zero-trust PR verification](./zero-trust-untrusted-pr-verification.md) shows how the signing step moves into a clean room when the contributor is untrusted.
- [Reviewer independence](./reviewer-independence.md) is the companion property that Proof of Execution deliberately leaves to a separate RFC.
