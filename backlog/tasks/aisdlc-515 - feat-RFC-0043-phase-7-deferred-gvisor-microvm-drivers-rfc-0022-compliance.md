---
id: AISDLC-515
title: 'feat(sandbox): RFC-0043 Phase 7 (deferred) — gVisor + MicroVM drivers for RFC-0022 compliance regimes'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - sandbox
  - compliance
  - deferred
dependencies:
  - AISDLC-514
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: low
dispatchable: false
dispatchableReason: 'Deferred until after the Docker v1 e2e milestone (AISDLC-514); requires self-hosted KVM runners + operator infra decisions for MicroVM'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the stronger sandbox drivers behind the abstraction (W9) so the RFC-0022 compliance-regime story is real: gVisor (userspace kernel, runs without KVM) and MicroVM/Firecracker (the HIPAA / FedRAMP / PCI-DSS Level 1 → MicroVM override). Today Podman/Kata/gVisor/MicroVM are throwing stubs, so `resolveEffectiveDriver` returning `microvm` for a regime would fail at spawn.

Deferred on purpose: the Docker v1 path (AISDLC-508..514) is the priority; MicroVM needs `/dev/kvm` (self-hosted runners), which is an infra decision, not a blocker for the first e2e.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `GVisorSandboxDriver` implemented (runsc) + integration-tested; documented setup
- [ ] #2 `MicroVmSandboxDriver` implemented (Firecracker/Kata) for self-hosted KVM runners; `resolveEffectiveDriver` regime override (HIPAA/FedRAMP/PCI-DSS L1 → microvm) actually spawns instead of throwing
- [ ] #3 Driver-selection docs + the compliance-regime claims in the whitepaper/runbook reconciled with what actually ships
- [ ] #4 build/test/lint clean; integration tests gated behind the runtime flag
<!-- AC:END -->
