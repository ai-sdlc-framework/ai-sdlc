---
id: AISDLC-508
title: 'feat(sandbox): RFC-0043 Phase 7 — real Docker sandbox driver (isolation + resource enforcement)'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - sandbox
  - security
dependencies:
  - AISDLC-507
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - pipeline-cli/src/pipeline/sandbox-runner.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the real `DockerSandboxDriver` (W1). Today `doSpawn` returns an error unless `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`, and `runDockerDifferentialTest` throws `"not yet implemented"`; the `docker run` invocation and resource enforcement exist only as comments, and `teardown()` is a no-op. This is the execution substrate everything else depends on.

Per AISDLC-507 (AQ1): Docker is the v1 reference runtime behind the existing `SandboxDriver` abstraction.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `DockerSandboxDriver` spawns a real container with hardened isolation: `--network=none` (until the inference.local bridge is added in AISDLC-510), `--cap-drop=ALL`, `--read-only` rootfs + explicit `tmpfs`, `--pids-limit`, `--memory`, `--cpus`, non-root `--user`, `--rm`, and a seccomp profile
- [ ] #2 Real resource enforcement: the wall-clock AbortController actually SIGKILLs the container on breach (not a post-hoc duration comparison); breach → `outcome: 'resource-breach'`
- [ ] #3 `teardown()` is real and idempotent (`docker rm -f`); no orphaned containers on success, error, or timeout
- [ ] #4 Credential-withholding enforced for the real run: `WITHHELD_ENV_VARS` (signing key, write-scoped `GITHUB_TOKEN`, `NPM_TOKEN`, `AI_SDLC_PAT`) provably never enter container env; add a test asserting this
- [ ] #5 Real-container tests behind `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`; hermetic mock path unchanged for default CI
- [ ] #6 `pnpm --filter @ai-sdlc/pipeline-cli build/test/lint` clean; new logic ≥80% patch coverage
<!-- AC:END -->

## Notes

Does NOT include the differential-test logic inside the container (AISDLC-509) or the inference bridge (AISDLC-510) — this is the container lifecycle + isolation + enforcement only.
