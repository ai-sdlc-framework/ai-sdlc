---
id: AISDLC-499
title: 'feat: RFC-0043 Phase 3 — OpenShell sandbox runner + differential testing + resource limits + driver abstraction (Docker/Kata/MicroVM) + RFC-0022 regime override'
status: To Do
assignee: []
created_date: '2026-06-02'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - phase-3
  - stage-2
  - sandbox
  - openshell
dependencies:
  - AISDLC-497
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0043. The core untrusted-execution layer: OpenShell sandbox lifecycle + differential testing harness + per-org resource limits + sandbox-driver abstraction composing with RFC-0022 regime overrides.

## Scope (RFC-0043 §Stage 2 + OQ-3 + OQ-5 resolutions)

### OpenShell sandbox runner

- `pipeline-cli/src/pipeline/sandbox-runner.ts` — OpenShell lifecycle wrapper
- Reads `.ai-sdlc/untrusted-pr.openshell.yaml` for sandbox policy (filesystem Landlock LSM, seccomp blockSyscalls, network deny-by-default OPA/Rego egress proxy, inference proxy injection)
- **Credential withholding at the proxy layer** — Anthropic API key injected at sandbox-local router; agent never receives it; same pattern for `GITHUB_TOKEN` (write-scope), `NPM_TOKEN`, `AI_SDLC_PAT`, `~/.ai-sdlc/signing-key.pem` (NEVER present in sandbox env)

### Differential testing harness

Sequence per RFC §Stage 2:
1. Clone clean upstream `main` into `/sandbox` (read-scoped token only)
2. Apply untrusted diff over `main`, restricted to files that passed Stage 1
3. Run trusted upstream test suite (`pnpm test`) → functional parity check
4. Run contributor's newly added tests with coverage → guards against no-op / coverage-gaming tests
5. Emit results to unsigned report artifact (Phase 2 schema)

### Resource limits (OQ-3 resolution)

Per `.ai-sdlc/untrusted-pr-gate.yaml: differentialTest.resourceLimits`:

- Default wall-clock: 10 minutes
- Default CPU: 2 cores
- Default memory: 4 GB
- Default network: deny-by-default
- All values per-org configurable
- Per-test timeout available as adopter-optional refinement

**On breach (OQ-3 resolution):**

- Hard abort (NOT soft abort with partial report)
- `needs-maintainer-review` label applied
- Post comment naming the breached limit ("Your test suite exceeded 10 minutes wall-clock")
- `Decision: untrusted-pr-resource-exhausted` emitted via RFC-0035 G0 catalog with details (limit type, breach magnitude, PR number)
- Operator reviews patterns via TUI batch surface

### Sandbox-driver abstraction (OQ-5 resolution)

`untrusted-pr-gate.yaml: sandboxDriver: docker|podman|kata|gvisor|microvm` (default `docker`):

- Docker / Podman: lightest setup; shared kernel; documented trade-off (runc CVE-2024-21626 "Leaky Vessels" class)
- Kata Containers: middle-ground VM-isolation with container UX (~5-10% runtime overhead)
- gVisor: middle-ground syscall interception (~10-15% runtime overhead)
- Firecracker MicroVM: strongest isolation; KVM-required; longest startup; highest per-instance memory

**RFC-0022 regime override** (OQ-5 resolution):

- HIPAA → MicroVM required (override Docker default)
- FedRAMP High → MicroVM required
- PCI-DSS Level 1 → MicroVM required
- Override mechanism composes with RFC-0030 OQ-13.3 residency-enforcement pattern (regime declaration → derivedGates → sandbox driver constraint)

### Hermetic tests

- Sandbox lifecycle: spawn / clone-clean-main / apply-diff / run-tests / emit-report / teardown
- Credential withholding invariant: agent process in sandbox cannot read host's `signing-key.pem`, write-scoped `GITHUB_TOKEN`, NPM token (verified by sandbox-escape attempt test)
- Resource limit enforcement: wall-clock breach → hard abort + Decision; memory breach → hard abort + Decision; CPU breach → hard abort + Decision; per-org config override respected
- Sandbox-driver abstraction: all 5 driver options instantiate correctly; regime override forces MicroVM when HIPAA/FedRAMP/PCI-DSS Level 1 declared
- Differential testing: upstream suite + new tests + coverage report emitted to unsigned report artifact

## Composes with

- AISDLC-497 (Phase 1): receives gate-passed work item; reads adopter config
- AISDLC-498 (Phase 2): emits unsigned report artifact for clean-room signer
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `sandbox-runner.ts` ships at `pipeline-cli/src/pipeline/`; OpenShell lifecycle (spawn / lifecycle / teardown)
- [ ] #2 `.ai-sdlc/untrusted-pr.openshell.yaml` schema ships; filesystem / seccomp / network / inference policy declarations per RFC §Stage 2
- [ ] #3 Credential withholding at proxy layer: agent process in sandbox CANNOT read host's signing-key.pem, write-scoped GITHUB_TOKEN, NPM_TOKEN, AI_SDLC_PAT (verified by sandbox-escape exfiltration-attempt test = AC-2 of RFC)
- [ ] #4 Differential testing sequence implemented per RFC §Stage 2 (clean clone → apply diff → upstream suite → new tests + coverage → emit report)
- [ ] #5 Resource limits: defaults 10min wall-clock / 2 CPU / 4GB / deny network; per-org configurable via `differentialTest.resourceLimits`
- [ ] #6 On breach: hard abort + `needs-maintainer-review` label + comment naming breached limit + `Decision: untrusted-pr-resource-exhausted` via RFC-0035 G0 catalog
- [ ] #7 Sandbox-driver abstraction supports Docker / Podman / Kata / gVisor / MicroVM; default Docker
- [ ] #8 RFC-0022 regime override: HIPAA / FedRAMP High / PCI-DSS Level 1 → MicroVM required automatically
- [ ] #9 Per-test timeout available as adopter-optional refinement (`differentialTest.perTestTimeoutSeconds`)
- [ ] #10 Hermetic tests cover credential withholding, resource enforcement (all 3 breach types), driver abstraction (all 5 options), regime override (all 3 regimes), differential testing sequence
<!-- AC:END -->
