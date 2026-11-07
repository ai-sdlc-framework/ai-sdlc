---
id: AISDLC-515.1
title: 'gVisor sandbox driver and config-time refusal of an unavailable driver (RFC-0043 Phase 7a)'
status: In Progress
assignee: []
created_date: '2026-11-07'
labels:
  - rfc-0043
  - rfc-0022
  - sandbox
  - compliance
dependencies: []
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - .ai-sdlc/untrusted-pr-gate.yaml
  - .github/workflows/untrusted-pr-gate.yml
  - docs/operations/untrusted-contributor-pr-verification.md
  - docs/whitepapers/untrusted-contributor-verification.md
  - docs/api-reference/rfc-0043-ucvg.md
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: medium
dispatchable: true
---

## Description

**Source.** Split (a) of the umbrella task AISDLC-515 (RFC-0043 Phase 7, deferred drivers) by operator ruling 2026-11-07. `GVisorSandboxDriver` in `pipeline-cli/src/pipeline/sandbox-runner.ts` is a stub that throws when a sandbox is started; `instantiateDriver` builds it on `sandboxDriver: gvisor` without checking that the `runsc` runtime exists on the host, and `loadSandboxConfig` / `parseSandboxConfig` accept any valid driver name. The RFC-0022 regime map (`MICROVM_REQUIRED_REGIMES`, `resolveEffectiveDriver`) therefore selects drivers that fail only at spawn time, while `docs/operations/untrusted-contributor-pr-verification.md` and the whitepaper present gVisor as a working upgrade driver. gVisor needs no `/dev/kvm`, so it can be built and tested on a hosted Ubuntu runner now; the MicroVM driver is AISDLC-515.2.

## Scope

1. **gVisor driver.** Implement `GVisorSandboxDriver` behind the existing `SandboxDriver` abstraction: the Docker run path of `DockerSandboxDriver` (`buildDockerRunArgs`, seccomp profile, resource limits, network deny) with `--runtime=runsc`, so the differential test runs under gVisor with the same contract as Docker. Reuse the Docker code; do not fork it.
2. **Integration test on a hosted runner.** A Vitest case (or a CI job step) that runs the driver with `runsc` installed under Docker on `ubuntu-latest`, gated on `runsc` being present (`AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` plus a `runsc` availability probe, matching the gating already used in `sandbox-runner.test.ts`); hermetic tests cover the argument builder and the availability check with a mock.
3. **Config-time refusal.** A driver availability check (docker binary and daemon for `docker`; `runsc` registered as a Docker runtime for `gvisor`; `/dev/kvm` plus the Firecracker binary for `microvm`; the equivalent for `podman` and `kata`, which stay stubs) evaluated when the config is loaded and after `resolveEffectiveDriver` has applied the regime override. An unavailable effective driver is refused at that point with one message naming the configured driver, the regime override if one applied, and what the host is missing. The `untrusted-pr-gate.yml` availability step (`Detect deployment mode and Docker sandbox availability`) consumes the same check so the workflow degrades fail-closed with the same message instead of a spawn-time throw.
4. **Docs.** `docs/operations/untrusted-contributor-pr-verification.md` (driver sections and the regime table), `docs/api-reference/rfc-0043-ucvg.md` (the factory paragraph that lists gVisor as a stub) and the whitepaper paragraph on regime overrides state what ships: gVisor works, MicroVM is pending AISDLC-515.2 and needs a KVM runner.

Out of scope: the MicroVM/Firecracker driver (AISDLC-515.2); Podman and Kata implementations; any change to the regime map itself.

## Acceptance Criteria

- [ ] #1 With `runsc` installed on an `ubuntu-latest` runner, the gated integration test runs the differential test through `GVisorSandboxDriver` and produces the same result shape as the Docker driver; the run is visible in CI (job or step gated on `runsc` presence).
- [ ] #2 Hermetic tests: the gVisor run arguments include `--runtime=runsc` and the Docker hardening flags; the driver availability check returns unavailable for `gvisor` when `runsc` is absent and for `microvm` when `/dev/kvm` is absent (filesystem and exec mocked).
- [ ] #3 Loading a config whose effective driver is unavailable on the host (including `complianceRegime: hipaa` on a host without KVM) fails at config load with a message that names the driver, the regime override when applied, and the missing host prerequisite; no sandbox is started.
- [ ] #4 `untrusted-pr-gate.yml` reports the same refusal through its existing degraded path; the workflow YAML tests under `.github/workflows/__tests__/` assert the step wiring.
- [ ] #5 The three docs pages describe gVisor as implemented and MicroVM as pending AISDLC-515.2; `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass.

## Ruling 2026-11-07 (operator, decision rubric)

Option A of the 2026-11-07 ruling on AISDLC-515: gVisor runs without KVM so it can ship and be tested on hosted runners now; MicroVM needs `/dev/kvm` (self-hosted runners), an infra decision the operator has not taken, so it is split into AISDLC-515.2 as bring-your-own-runner. Counter-argument (gVisor on hosted CI is a toy, only MicroVM matters for HIPAA) rejected because the MicroVM blocker is independent of this code and 515.1 removes gVisor from its critical path. Config-time refusal closes the gap between the whitepaper's regime mapping and a spawn-time throw.

## References

- `pipeline-cli/src/pipeline/sandbox-runner.ts`: `GVisorSandboxDriver`, `resolveEffectiveDriver`, `createSandboxDriver`, `loadSandboxConfig`.
- `docs/operations/untrusted-contributor-pr-verification.md`: driver sections and the regime table.
- RFC-0043 Phase 7 (AQ1) and OQ-5; RFC-0022 regime overrides.
