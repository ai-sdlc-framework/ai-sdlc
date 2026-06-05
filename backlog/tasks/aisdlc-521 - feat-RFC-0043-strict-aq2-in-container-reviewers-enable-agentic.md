---
id: AISDLC-521
title: 'feat(sandbox): RFC-0043 strict AQ2 — run Stage-3 reviewers INSIDE the sandbox via proxy-only egress (enables agentic reviewers)'
status: To Do
assignee: []
created_date: '2026-06-05'
labels:
  - rfc-0043
  - phase-7
  - sandbox
  - security
dependencies:
  - AISDLC-520
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-520 wired the inference.local proxy but runs the Stage-3 reviewers **host-side**
(on the runner, which holds the provider key + open internet). That is acceptable for the
current **plain-completion** reviewers (one model call, diff-as-text in, verdict-JSON out,
no tools) — an injected reviewer can only return a bad verdict, which consensus +
injection-detection catch; it cannot *act* to exfiltrate.

This task implements the **strict AQ2** form the RFC/whitepaper describes: the reviewers
execute **inside the hardened sandbox container**, with egress restricted to the
`inference.local` proxy ONLY (no direct internet, no provider credential in-container).
The proxy (host-side, holds the key + has internet) forwards reviewer requests to the
upstream provider with the key injected.

**Why this matters / what it unlocks:** it is the prerequisite for **agentic reviewers** —
reviewers that investigate the untrusted code with tools (read files, run the tests, explore
the repo) rather than just reading the diff text. An agentic reviewer is far more powerful
but **acts** in its environment, so a prompt-injection in the untrusted PR could make it run
exfiltration commands. Host-side that would be a real breach; inside the proxy-only container
(no key, no egress except the proxy) it is contained. Operator decision 2026-06-05:
ship plain+host-side now (AISDLC-520), build strict in-container next (this task).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The reviewer container's network is a **proxy-only pinhole**: it can reach the inference.local proxy and NOTHING else (no direct internet, no LAN). NOTE this is NOT `--network=none` (which the Stage-2 differential-test container uses for running untrusted code) — it requires a locked-down network (custom internal bridge with only the proxy, or host-gateway + an egress firewall) — design + justify the chosen mechanism.
- [ ] #2 The Stage-3 reviewers EXECUTE inside that container (a reviewer entrypoint), not in the host ucvg process; the provider credential is NEVER present in the container (assert `buildReviewerProxyEnv` excludes it).
- [ ] #3 The proxy forwards in-container reviewer requests to the upstream provider (api.anthropic.com) with the credential injected, and streams the response back; verdicts are returned from the container to the host via a **mounted volume** (parsed host-side), not stdout scraping.
- [ ] #4 Credential-withholding proven: a hermetic test asserts an in-container process cannot reach the provider key or any host beyond inference.local (reuse the AISDLC-513 credential-exfiltration vector against the live container under AI_SDLC_SANDBOX_INTEGRATION_TESTS=1).
- [ ] #5 Hermetic coverage (508 _spawnProcess / 510 proxy seams) for the network restriction + verdict-return contract; patch coverage ≥80% on changed non-test source.
- [ ] #6 A benign untrusted PR still passes end-to-end (real in-container reviewers approve → v6 attestation status=valid) — validated on the fork harness ai-sdlc-enterprise/ai-sdlc-ucvg-test (operator/loop-gated live run).
- [ ] #7 (Stretch / separate follow-up if large) document the path to AGENTIC reviewers (tools in-container) now that containment exists; do NOT implement agentic tool-use in this task unless trivial.
- [ ] #8 build/test/lint/format clean; no AISDLC-NNN tracker IDs in runtime/workflow-echoed strings; isolated mkdtemp; no shared /tmp/.ai-sdlc.
<!-- AC:END -->

## Notes

Security-critical (AQ2 trust chain) — reconcile with an operator-composed/-reviewed security
verdict. Builds on AISDLC-520 (host-side proxy wiring). The `--network=none` vs
proxy-only-pinhole distinction (surfaced by the operator on 2026-06-05) is the core design
work: the reviewer stage needs a single egress to the proxy, unlike the Stage-2
untrusted-code stage which gets zero network.
<!-- SECTION:NOTES -->
