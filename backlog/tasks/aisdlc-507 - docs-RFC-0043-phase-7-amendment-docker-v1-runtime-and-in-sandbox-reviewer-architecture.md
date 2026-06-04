---
id: AISDLC-507
title: 'docs(rfc): RFC-0043 Phase 7 amendment — Docker v1 reference runtime + in-sandbox reviewer via inference.local'
status: To Do
assignee: []
created_date: '2026-06-04'
labels:
  - rfc-0043
  - phase-7
  - integration
  - architecture
  - docs
dependencies: []
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Records the two Phase-7 architecture decisions (operator-approved via decision rubric, 2026-06-04) into RFC-0043 so the implementation tasks (AISDLC-508..515) have a signed contract. **The decisions are already made — this task documents them, it does not re-open them.**

- **AQ1 — Sandbox runtime:** **Docker (hardened)** is the v1 reference runtime, behind the existing `SandboxDriver` abstraction. gVisor and MicroVM/Firecracker become documented *upgrade* drivers (MicroVM is the RFC-0022 compliance path). NVIDIA OpenShell is demoted from "the" runtime to an optional driver pending resolution of its GitHub-runner install-hang. Rationale: Docker is the only zero-install path on stock GitHub-hosted runners (no `/dev/kvm`), so it is the only viable route to a working end-to-end gate now; the driver abstraction preserves the upgrade path.
- **AQ2 — Reviewer execution:** the 3-reviewer matrix runs **inside the sandbox**, reaching the model through an **`inference.local` proxy** that injects provider credentials out-of-process so the reviewer/untrusted process never holds the key. This matches the RFC's original credential-withholding design and keeps the agentic-review upgrade path open.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 RFC-0043 revision history + body updated: Docker named the v1 reference runtime; gVisor/MicroVM/OpenShell documented as alternative drivers behind the abstraction
- [ ] #2 RFC-0043 documents the in-sandbox reviewer + `inference.local` credential-withholding proxy as the Stage-3 execution model
- [ ] #3 The whitepaper + concept page + operator runbook claims are reconciled with "Docker v1 / others are upgrade drivers" (no implied MicroVM-is-shipping)
- [ ] #4 A short "Phase 7 — Integration & End-to-End Hardening" section enumerates the implementation tasks (508..515) + the e2e milestone definition
- [ ] #5 RFC-0043 lifecycle stays Signed Off; this is an amendment, not a re-sign-off
<!-- AC:END -->

## Notes

Decision rubric run 2026-06-04 (AQ1 → Docker; AQ2 → in-sandbox + inference.local). Foundational — 508..515 reference this amendment.
