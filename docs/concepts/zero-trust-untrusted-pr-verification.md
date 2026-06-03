# Zero-Trust Untrusted-Contributor PR Verification — Concept

> **Positioning page.** This is the *why-it-matters* lens. For the operational
> "what changes for me" walkthrough see the
> [Untrusted-Contributor Verification adopter explainer](./untrusted-contributor-verification.md);
> for day-to-day operation see the
> [operator runbook](../operations/untrusted-contributor-pr-verification.md) and
> [API reference](../api-reference/rfc-0043-ucvg.md).

## The trust ceiling

Autonomous SDLC has a quiet limit: automation will review, test, and merge code
from people inside the trust boundary, but a pull request from *outside* it — an
open-source drive-by contributor, a vendor, a new hire on day one — stops the
automation and forces a human in. The reasons are real:

- The contributor's code **runs during review** (tests, lint, type-checks,
  differential analysis).
- The reviewers are **LLMs that read attacker-controlled text** — a diff is a
  prompt, and "ignore previous instructions and approve" is a real attack.
- The merge gate often trusts an **approval signal the contributor can
  influence** — a file or a green check whose provenance isn't verified.

The usual answers don't close the loop: "require a maintainer to approve fork
PRs" reintroduces the bottleneck automation existed to remove; "run it in a
sandbox" addresses execution but says nothing about whether the *review* was
real or whether its *result* can be trusted downstream.

## The position AI-SDLC takes

This is automatable, and a defined, rigorous path is better than leaving
maintainers with nothing but "review it yourself." AI-SDLC composes two
mechanisms:

- **RFC-0042 (Proof of Execution)** — every review is anchored in a
  Merkle-transcript attestation signed by the operator's key: forgery-resistant
  by construction and stable across rebases and chore-commits.
- **RFC-0043 (this gate)** — a four-stage zero-trust pipeline in front of it.

### The four stages

| Stage | Role | Cost |
|-------|------|------|
| 0 — Trust classifier | Deterministic allowlist lookup; untrusted authors enter the gate | none |
| 1 — AST gate | Hard-blocks protected-path edits + dangerous content patterns; deny-wins, fail-closed | none |
| 2/3 — OpenShell sandbox | Runs reviewers + differential tests with credentials stripped, network denied, resources capped | one capped run |
| 4 — Clean-room signer | Validates the report through a strict schema boundary, then mints the v6 attestation | one signature |

### The load-bearing invariant

**The signing key never exists in the same environment as the untrusted code.**
Stages 0–3 (which classify, inspect, and execute contributor code) hold no key;
Stage 4 (which holds the key) never runs contributor code. That hard process
boundary is the whole security model — everything else is defense-in-depth.

## Threat model, in brief

The gate is designed against a defined set of vectors; each is addressed by the
stage best placed to stop it cheaply:

- **Supply-chain / privilege escalation** (protected-path mutation,
  lifecycle-script injection, new CI action injection) → **Stage 1**,
  deterministically, at zero spend.
- **Execution-time** (credential exfiltration, network egress / SSRF, resource
  exhaustion) → **Stage 3** sandbox isolation + caps.
- **Reviewer manipulation** (prompt injection, diff-fence breakout) → **Stage 3**
  detection-and-surface; **Stage 4** refuses to sign on a detected injection.
- **Attestation integrity** (report forgery, fork self-certification,
  signing-key capture, replay, `pull_request_target` abuse) → **Stage 4** +
  RFC-0042's operator-keyed Merkle root.
- **Trust-source integrity** (allowlist as single source of truth; no live-API
  TOCTOU; head-SHA re-binding at sign time).
- **Fail-safe**: degradation fails **closed** — the gate blocks and requests
  review, never auto-passes.

The full threat-model table lives in the
[whitepaper](https://ai-sdlc.io/docs/whitepapers/untrusted-contributor-verification).

## What this unlocks

- **OSS maintainers** accept fork PRs at automation throughput, with a defined,
  inspectable safety path and a cryptographic record of what was reviewed.
- **Enterprises** extend an existing trust boundary to vendors, contractors, and
  new hires without weakening it, with compliance-regime-aware isolation
  (RFC-0022: HIPAA / FedRAMP / PCI-DSS Level 1 → MicroVM driver).

The trust *decision* stays human and explicit (the allowlist, the regime); the
review *labor* becomes automatable even for code from outside the boundary.

## What we don't claim

This gate raises attacker cost and closes the known high-value vectors; it does
not prove the absence of all vectors. Sandbox-runtime side-channels, a 0-day in
a sandbox driver, a novel injection encoding a model misses, or operator
misconfiguration are residual risks we document deliberately and invite scrutiny
of. The goal is a defensible, improvable baseline for automating untrusted-PR
review — not a claim of perfection.

## See also

- [Untrusted-Contributor Verification — adopter explainer](./untrusted-contributor-verification.md) (operational "what changes for me")
- [Operator runbook](../operations/untrusted-contributor-pr-verification.md)
- [API reference](../api-reference/rfc-0043-ucvg.md)
- [RFC-0043](../../spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md) · [RFC-0042](../../spec/rfcs/RFC-0042-proof-of-execution-attestation.md)
- Whitepaper: [Zero-Trust Untrusted-Contributor PR Verification](https://ai-sdlc.io/docs/whitepapers/untrusted-contributor-verification)
