---
id: AISDLC-520
title: "Wire RFC-0043 AQ2 — inference.local credential-withholding proxy in sandbox-run"
status: Done
priority: high
area: pipeline
created: "2026-06-05"
completed: "2026-06-05"
---

## Summary

Assembled the existing RFC-0043 AQ2 pieces (InferenceProxy, buildReviewerProxyEnv,
buildProxyHostArg, DockerSandboxDriver) into a working proxy-mediated reviewer path:

1. `runSandboxAndReview` starts the `InferenceProxy` (AC#1) in integration mode when
   `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` + `ANTHROPIC_API_KEY` are present; stops it
   in a try/finally to prevent credential lingering.

2. Proxy env vars (`INFERENCE_PROXY_HOST/PORT/SESSION`) are set in the process env so
   `resolveModelClient()` builds a real `InferenceProxyClient` (AC#2).

3. `buildReviewerProxyEnv` (no credential) is passed as `sandboxEnv` and
   `buildProxyHostArg` is passed as `proxyHostArgs` to `runSandbox()`, which
   threads them into the Docker driver (AC#3).

4. `runSandbox` interface extended with `sandboxEnv` + `proxyHostArgs`; `buildDockerRunArgs`
   extended with `extraDockerArgs`; `SandboxSpawnInput` extended with `extraDockerArgs`.

5. Hermetic tests in `aq2-proxy-wiring.test.ts` cover 32 cases: credential withholding,
   --add-host placement, runSandbox passthrough, seam injection, validateSandboxEnv gates.

6. Workflow re-enables `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` conditionally (when
   `ANTHROPIC_API_KEY` is configured).

## Escalated OQ: In-Container Reviewer Execution

AQ2 strict form (reviewers execute INSIDE the container) requires a new in-container
reviewer entrypoint and a contract for how verdicts return from the container. This is
an architectural decision beyond assembling existing pieces — escalated per task brief.
The proxy-mediated host-side reviewer path is implemented; in-container execution is
operator-gated.

## AC Status

- AC#1: proxy start/stop lifecycle — implemented
- AC#2: env var wiring for resolveModelClient — implemented
- AC#3: buildProxyHostArg + buildReviewerProxyEnv in sandbox — implemented
- AC#4: live e2e validation — operator/loop-gated (not automated)
- AC#5: hermetic tests ≥80% patch coverage — 32 tests, all passing
- AC#6: workflow re-enable — implemented (credential-conditional)
