---
id: AISDLC-6
title: Integrate NVIDIA OpenShell as sandbox runtime for agent execution
status: Done
assignee: []
created_date: '2026-03-24 21:45'
updated_date: '2026-03-24 22:03'
labels:
  - security
  - infrastructure
  - integration
dependencies: []
references:
  - 'https://github.com/NVIDIA/OpenShell'
  - 'https://docs.nvidia.com/openshell/latest/reference/policy-schema.html'
  - reference/src/security/interfaces.ts
  - reference/src/security/docker-sandbox.ts
  - orchestrator/src/execute.ts
  - orchestrator/src/security.ts
documentation:
  - 'https://docs.nvidia.com/openshell/latest/index.html'
  - >-
    https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the no-op stub sandbox with NVIDIA OpenShell to provide kernel-level security enforcement for AI agent execution. OpenShell provides Landlock filesystem isolation, seccomp syscall filtering, network policy enforcement, credential injection via providers, and inference routing — all enforced at the infrastructure layer rather than via prompt instructions.

## Integration Architecture

1. **New sandbox implementation** (`reference/src/security/openshell-sandbox.ts`) — implements the existing `Sandbox` interface by shelling out to the `openshell` CLI
2. **Policy generation** — maps ai-sdlc YAML config (AgentRole constraints, Pipeline credentials, SandboxConstraints) to OpenShell policy YAML
3. **Runner integration** — modify runners to spawn agents inside OpenShell sandboxes via `openshell sandbox exec <id> --` prefix
4. **GitHub Actions setup** — add OpenShell installation step to CI workflows
5. **Progressive trust mapping** — autonomy levels map to progressively wider OpenShell policies

## Key files to create/modify
- `reference/src/security/openshell-sandbox.ts` (new)
- `reference/src/security/openshell-policy.ts` (new — policy YAML generation)
- `orchestrator/src/runners/claude-code.ts` (spawn inside sandbox)
- `orchestrator/src/security.ts` (wire up OpenShell sandbox factory)
- `.github/workflows/ai-sdlc.yml` (add OpenShell setup step)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 createOpenShellSandbox() implements the Sandbox interface and manages sandbox lifecycle via openshell CLI
- [x] #2 Policy generator maps AgentRole.blockedPaths, Pipeline.credentials, and SandboxConstraints to valid OpenShell policy YAML
- [x] #3 ClaudeCodeRunner can spawn agents inside an OpenShell sandbox when configured
- [x] #4 Credential injection uses OpenShell providers instead of process.env inheritance
- [x] #5 Unit tests cover sandbox creation, policy generation, and runner integration
- [x] #6 Fallback to stub sandbox when OpenShell is not installed
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## NVIDIA OpenShell Sandbox Integration

Integrated NVIDIA OpenShell as a sandbox runtime for AI agent execution, providing kernel-level security enforcement (Landlock LSM, seccomp, network policies) that replaces the no-op stub sandbox.

### Files created
- `reference/src/security/openshell-policy.ts` — Policy generator mapping AI-SDLC config to OpenShell YAML
- `reference/src/security/openshell-sandbox.ts` — Sandbox interface implementation via openshell CLI
- `reference/src/security/openshell-policy.test.ts` — 17 tests
- `reference/src/security/openshell-sandbox.test.ts` — 20 tests

### Files modified
- `reference/src/security/index.ts` — Export new modules
- `orchestrator/src/security.ts` — Add createOpenShellSandboxProvider with auto-fallback
- `orchestrator/src/runners/types.ts` — Add sandboxId to AgentContext
- `orchestrator/src/runners/claude-code.ts` — Spawn via openshell sandbox connect when sandboxId set
- `orchestrator/src/execute.ts` — Pass sandboxId through to runner
- `.github/workflows/ai-sdlc.yml` — Add OpenShell install step
- `docs/api-reference/security.md` — Full OpenShell API documentation
- `docs/api-reference/runners.md` — Sandbox integration section

### Key features
- Credential auto-provisioning via autoProviders config
- Autonomy level → policy mapping (level 0: hard Landlock + no network, level 1+: best-effort + configured network)
- Graceful fallback to stub sandbox when OpenShell is not installed
- 37 tests covering policy generation, serialization, sandbox lifecycle, provider management
<!-- SECTION:FINAL_SUMMARY:END -->
