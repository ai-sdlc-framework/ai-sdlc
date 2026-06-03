---
id: AISDLC-496
title: 'docs(marketing): whitepaper + framework docs + website page for zero-trust untrusted-contributor PR verification (RFC-0042 + RFC-0043)'
status: To Do
assignee: []
created_date: '2026-06-02'
labels:
  - marketing
  - whitepaper
  - docs
  - rfc-0042
  - rfc-0043
  - positioning
  - untrusted-pr-verification
dependencies: []
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
permittedExternalPaths:
  - '../ai-sdlc-io/'
dispatchable: false
dispatchableReason: 'Marketing voice + positioning — operator-in-loop required; not a mechanical implementation task'
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Produce three composable marketing/positioning artifacts that explain AI-SDLC's zero-trust verification story for untrusted-contributor PRs, anchored on the composition of RFC-0042 (Proof-of-Execution Attestation via Merkle Transcripts) + RFC-0043 (Untrusted-Contributor PR Verification Gate).

The story to tell: AI-SDLC is the only autonomous-SDLC framework that ships a **forgery-resistant, cryptographically-anchored, sandboxed verification path for PRs from contributors the maintainer does not trust**. RFC-0042 ships the Merkle-transcript attestation substrate (signed by the operator's key; head-binding survives rebase + chore commits per AISDLC-419 + AISDLC-448). RFC-0043 layers a 4-stage gate on top: Stage 0 trust classifier (deterministic), Stage 1 AST gate (hard-block on protected paths with zero LLM/sandbox spend), Stage 2/3 OpenShell sandbox (credential-stripped reviewer execution), Stage 4 clean-room signer (mints the v6 attestation only after Zod-validated unsigned report passes). Together: the contributor cannot escalate privilege, cannot exfiltrate maintainer credentials, cannot forge an attestation, and cannot inject prompts into the reviewers — yet the maintainer's review labor is fully automated.

Three deliverables:

### 1. Marketing whitepaper (long-form, ~6-10 pages)

Audience: technical decision-makers (CTOs, platform engineers, security leads, OSS maintainers). Tone: confident, technical, evidence-anchored — not breathless. Lives in this repo's `marketing/whitepapers/` or sibling `../ai-sdlc-io/` if the operator routes it there.

Sections:
- **Executive summary** — the trust problem in autonomous SDLC + what AI-SDLC ships that nobody else does
- **The trust gap** — why the industry's existing answer ("require maintainer review on fork PRs") doesn't scale; why naive sandboxing fails; the prompt-injection vector against LLM reviewers
- **RFC-0042 substrate** — Merkle-transcript attestation; operator-keyed signing; rebase-invariant head-binding (AISDLC-419 + AISDLC-448); why content-addressed envelopes (AISDLC-398) make this composable with the no-merge-queue direct-merge model (AISDLC-400)
- **RFC-0043 gate** — the 4-stage pipeline; OQ resolutions that drove the design (trusted-reviewers.yaml schema convergence, CI-default deployment, OpenShell sandboxing, operator-key-only signing, RFC-0022 regime override semantics, deterministic vs LLM-based content heuristics)
- **Threat model walk-through** — what an adversarial fork-PR contributor can attempt and where each attempt is blocked (protected-path mutation → Stage 1 abort; credential exfiltration → Stage 3 credential withholding; prompt injection → Stage 3 reviewer finding; report forgery → Stage 4 clean-room Zod boundary)
- **Composition with RFC-0022 compliance regimes** — HIPAA / FedRAMP / PCI-DSS Level 1 regime override forces MicroVM sandbox driver; default Docker for non-regulated repos
- **What this unlocks** — OSS maintainers can accept fork PRs at autonomous-SDLC throughput; enterprises with compliance posture can extend their existing trust boundary without breaking it; framework-level rather than per-repo bolt-on
- **Production readiness** — RFC-0042 is Implemented (AISDLC-409, default-on since 2026-05-23); RFC-0043 is Ready for Review with 6 phase tasks queued (AISDLC-497..502)

### 2. Framework documentation page (`docs/concepts/zero-trust-untrusted-pr-verification.md`)

Adopter-facing explainer. Plain language. Cross-links to RFC-0042 + RFC-0043 + operator runbooks. Sections:
- What problem this solves
- How the composition works (RFC-0042 substrate + RFC-0043 gate)
- What changes for the maintainer (CI-default per OQ-2 — minimal operational change)
- What changes for the contributor (Stage 1 may auto-abort PRs touching protected paths; clear feedback comment; no LLM/sandbox cost burned on those)
- How to enable (feature flag `AI_SDLC_UNTRUSTED_PR_GATE`; promotion path)
- Composition with compliance posture (RFC-0022 regime override)
- Operator runbook + API reference cross-links (AISDLC-502 deliverables)

### 3. Website page (sibling repo `../ai-sdlc-io/`)

Positioning + lead-capture surface. Composes with the existing website's architecture (operator decides exact route — likely `/zero-trust` or `/secure-untrusted-prs`). Shorter than the whitepaper, more visual. Cross-links to the whitepaper PDF + framework docs page. Includes the threat-model walk-through as the centerpiece.

## Composes with

- RFC-0042 (Implemented — Merkle-transcript attestation substrate)
- RFC-0043 (Ready for Review — 4-stage verification gate; OQ walkthrough complete 2026-06-02)
- RFC-0022 (compliance posture regime overrides; whitepaper threat-model section ties them in)
- AISDLC-497..502 (Phase 1-6 implementation tasks for RFC-0043)
- Existing positioning artifacts in repo + `../ai-sdlc-io/` (operator confirms voice + visual consistency)

## Why not dispatchable

Marketing voice and positioning require operator-in-loop iteration. Whitepapers ship under the operator's signature and must reflect the operator's chosen narrative arc. A dispatched dev subagent would produce technically-correct but tone-flat copy. The right path: pair with the operator on draft → iterate → ship.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Whitepaper (~6-10 pages) drafted with the 8 sections above, anchored on RFC-0042 + RFC-0043 composition
- [ ] #2 Whitepaper threat-model section walks through ≥4 adversarial attempts and where each is blocked
- [ ] #3 Whitepaper covers RFC-0022 compliance regime override semantics (HIPAA / FedRAMP / PCI-DSS Level 1 → MicroVM)
- [ ] #4 Whitepaper cites all 6 RFC-0043 OQ resolutions where the design decisions matter for the narrative
- [ ] #5 Framework docs page `docs/concepts/zero-trust-untrusted-pr-verification.md` ships with adopter-facing explainer
- [ ] #6 Framework docs page cross-links to RFC-0042, RFC-0043, AISDLC-502 operator runbook + API reference
- [ ] #7 Website page lands in `../ai-sdlc-io/` (route TBD by operator; lead-capture surface)
- [ ] #8 Website page includes the threat-model walk-through as centerpiece
- [ ] #9 All three artifacts cross-reference each other (whitepaper ↔ docs page ↔ website page)
- [ ] #10 Operator approves voice + positioning before any artifact ships publicly
- [ ] #11 Whitepaper PDF rendered + linked from website page
- [ ] #12 `backlog-drift check` passes after task closure
<!-- AC:END -->
