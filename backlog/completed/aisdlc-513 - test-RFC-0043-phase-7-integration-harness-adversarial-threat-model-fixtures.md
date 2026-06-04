---
id: AISDLC-513
title: 'test(sandbox): RFC-0043 Phase 7 — integration harness + adversarial threat-model fixtures'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - test
  - security
dependencies:
  - AISDLC-512
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prove each threat-model vector actually holds against the real runtime (W6). Today only hermetic mocks exist; this builds the real-container integration harness (`AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`) + a fixture corpus of sample PRs, one per vector from the whitepaper threat model.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Integration harness runs the full gate against a real Docker runtime on a fixture repo
- [ ] #2 Fixture PRs + assertions, one per vector: benign → passes + valid attestation; protected-path mutation → Stage 1 `abort-protected-path`; lifecycle-script / new-action injection → Stage 1 abort; prompt injection → Stage 3 `promptInjectionDetected` + Stage 4 refusal; credential exfiltration attempt → Stage 3 network-deny / withholding blocks it; resource exhaustion → `resource-breach` fail-closed; report forgery → Stage 4 Zod refusal
- [ ] #3 A credential-exfil fixture proves a process in the sandbox cannot reach the signing key, write tokens, or any host beyond inference.local
- [ ] #4 Harness is gated (not in default CI) + documented so a maintainer can run it locally; flaky-free (isolated temp dirs, no shared `/tmp/.ai-sdlc`)
- [ ] #5 Results documented (which vector → which stage → observed outcome) as the conformance evidence the whitepaper references
<!-- AC:END -->
