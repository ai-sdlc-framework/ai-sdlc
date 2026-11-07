---
id: AISDLC-515.2
title: 'MicroVM (Firecracker) driver as bring-your-own-KVM-runner (RFC-0043 Phase 7b)'
status: To Do
assignee: []
created_date: '2026-11-07'
labels:
  - rfc-0043
  - rfc-0022
  - sandbox
  - compliance
dependencies:
  - AISDLC-515.1
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - .ai-sdlc/untrusted-pr-gate.yaml
  - docs/operations/untrusted-contributor-pr-verification.md
  - docs/operations/e2e-real-repo-runbook.md
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: medium
dispatchable: false
dispatchableReason: 'Parked by operator ruling 2026-11-07: needs a Linux runner with /dev/kvm; dispatch when the operator provisions one.'
---

## Description

**Source.** Split (b) of the umbrella task AISDLC-515 by operator ruling 2026-11-07. `MicroVmSandboxDriver` in `pipeline-cli/src/pipeline/sandbox-runner.ts` is a stub that throws; `resolveEffectiveDriver` forces it for the `hipaa`, `fedramp-high` and `pci-dss-level-1` regimes (RFC-0043 OQ-5, RFC-0022). After AISDLC-515.1 such a config is refused at load time on a host without `/dev/kvm`; this task makes the driver real on a host that has it. Stock GitHub-hosted runners have no KVM, so the driver is tested only where the adopter brings a runner.

## Scope

1. **Firecracker driver.** Implement `MicroVmSandboxDriver`: one microVM per differential-test evaluation, same `SandboxDriver` contract and resource limits as the Docker driver (wall clock, CPU, memory, network deny), the repository checkout and the test command passed in the same way, the result parsed into the same shape. Reuse the Docker path's script and parsing; add only the VM lifecycle (kernel and rootfs image selection, boot, exec, teardown).
2. **Contract test.** The integration test runs the shared driver contract against the MicroVM driver and is skipped unless `/dev/kvm` exists and the Firecracker binary is on `PATH` (in addition to `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`). Hermetic tests cover the VM argument and config builders with mocks.
3. **Bring-your-own-runner docs.** A section in `docs/operations/untrusted-contributor-pr-verification.md` (next to the regime table) documenting that the MicroVM compliance override requires a self-hosted Linux runner with `/dev/kvm` and Firecracker installed, the runner labels the workflow expects, and what the config-time refusal from AISDLC-515.1 reports when the runner lacks them; `docs/operations/e2e-real-repo-runbook.md` gains the KVM variant of its end-to-end run.

Out of scope: hosted-runner support for MicroVM; Kata as the MicroVM backend (Firecracker only, per RFC-0043 Phase 7 AQ1); any change to the regime map.

## Acceptance Criteria

- [ ] #1 On a Linux host with `/dev/kvm` and Firecracker, the contract test runs the differential test through `MicroVmSandboxDriver` with the configured resource limits and network denied, and returns the same result shape as the Docker driver.
- [ ] #2 On a host without `/dev/kvm` the contract test is skipped with a reason naming the missing prerequisite; the hermetic suite still passes.
- [ ] #3 `complianceRegime: hipaa` on a KVM host passes the AISDLC-515.1 availability check and spawns the MicroVM driver; the override reason is logged as today.
- [ ] #4 The docs name the runner requirement (Linux, `/dev/kvm`, Firecracker, runner labels) and the refusal message an adopter sees without it; `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass.

## Ruling 2026-11-07 (operator, decision rubric)

Option A of the 2026-11-07 ruling on AISDLC-515: gVisor ships now on hosted runners (AISDLC-515.1); MicroVM needs `/dev/kvm`, an infra decision the operator has not taken, so it is parked here as bring-your-own-runner rather than blocking gVisor. Counter-argument (only MicroVM matters for HIPAA) rejected: the MicroVM blocker is the runner, not the code, and the split removes gVisor from its critical path.

## References

- `pipeline-cli/src/pipeline/sandbox-runner.ts`: `MicroVmSandboxDriver`, `MICROVM_REQUIRED_REGIMES`, `resolveEffectiveDriver`.
- RFC-0043 Phase 7 (AQ1) and OQ-5; RFC-0022 regime overrides.
