---
id: AISDLC-510
title: 'feat(sandbox): RFC-0043 Phase 7 — inference.local credential-withholding model proxy'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - sandbox
  - security
dependencies:
  - AISDLC-508
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - pipeline-cli/src/pipeline/sandbox-runner.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the `inference.local` proxy (W4) — the security-critical component that makes AQ2 (in-sandbox reviewers) safe. Currently it exists only as comments in `sandbox-runner.ts`. The in-sandbox reviewer process (AISDLC-511) must be able to call the model **without ever holding the provider key**; the proxy injects credentials out-of-process.

This is the trust hinge of the in-sandbox-reviewer architecture: the sandbox is otherwise `--network=none`, with the proxy as the *only* reachable egress.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A host-side proxy process holds the provider credential and exposes a minimal model endpoint reachable from the container as `inference.local` (e.g. a controlled bridge / host alias) — the credential is NEVER passed into the container env
- [ ] #2 Sandbox network policy: the container can reach ONLY the proxy endpoint; all other egress denied (compose with AISDLC-508's `--network=none` + an explicit allow for the proxy)
- [ ] #3 The proxy is request-scoped to the PR being reviewed and rate/size-capped; it refuses tool-use / non-review calls so a prompt-injected reviewer can't turn it into a general exfiltration channel
- [ ] #4 Proxy logs requests for audit without logging the credential; redaction tested
- [ ] #5 Test: a process inside the container can complete a model call via inference.local with NO provider env var present; a direct outbound call to any other host fails
- [ ] #6 build/test/lint clean; ≥80% patch coverage on proxy logic
<!-- AC:END -->

## Notes

Security-critical — recommend the operator-composed verdict pattern at reconcile time (this closes a trust-chain hole). Threat to design against: a prompt-injected in-sandbox reviewer trying to use the proxy as an egress for exfiltrated secrets — hence the request-scoping + no-tool-use constraints.
