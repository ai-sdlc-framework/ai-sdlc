---
id: AISDLC-520
title: 'feat(sandbox): RFC-0043 AQ2 — wire in-sandbox reviewers via the inference.local credential-withholding proxy (assemble 508+510+511 into a real Stage 2/3)'
status: To Do
assignee: []
created_date: '2026-06-05'
labels:
  - rfc-0043
  - phase-7
  - sandbox
  - security
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The AISDLC-514 live e2e proved the RFC-0043 headline architecture (**AQ2: reviewers run
INSIDE the sandbox via the inference.local credential-withholding proxy**) was built as
PARTS but never ASSEMBLED. The pieces exist — the Docker driver (AISDLC-508), the
`InferenceProxy` server + `buildReviewerProxyEnv` + `buildProxyHostArg` helpers
(AISDLC-510, `pipeline-cli/src/pipeline/inference-proxy.ts`), the reviewer matrix
(AISDLC-511, `runReviewerMatrix` in `reviewer-runner.ts`), and the glue/signer
(AISDLC-512) — but the orchestration that wires them together is missing:

1. **Nothing starts the `InferenceProxy` server** in the sandbox-run flow (only an example
   + a CLI entry instantiate it).
2. **`INFERENCE_PROXY_HOST/PORT/SESSION` are never set** — so `resolveModelClient`
   (`pipeline-cli/src/cli/ucvg.ts`) never builds a real `InferenceProxyClient`; it
   hard-errors (the AISDLC-519 Bug D) or falls back to the fail-closed `FakeModelClient`.
3. **`runReviewerMatrix` runs in the host `ucvg.ts` process (line ~235), not inside the
   sandbox container** — so even if a real client were built, the AQ2 credential-withholding
   property (reviewer cannot reach the provider key; only `inference.local`) is not enforced.

Result: every untrusted PR lands on the fake/fail-closed path; no benign PR can produce a
valid attestation; the gate cannot do real review. This task assembles the existing pieces
into a working, security-correct Stage 2/3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `sandbox-run` (integration mode) starts the `InferenceProxy` for the PR (credential = ANTHROPIC_API_KEY), obtains its host/port/sessionToken, and tears it down on completion (proxy lifecycle owned by the sandbox orchestrator).
- [ ] #2 The reviewer process resolves a real `InferenceProxyClient` (via `INFERENCE_PROXY_HOST/PORT/SESSION` set by the orchestrator, or direct injection) — no env-var-nobody-sets gap, no hard-error, no silent FakeModelClient when a credential is present.
- [ ] #3 AQ2 enforced: the reviewers execute INSIDE the hardened Docker container (network-deny except the `inference.local` bridge via `buildProxyHostArg`), with the provider credential WITHHELD from the container (`buildReviewerProxyEnv` excludes it) — the container reaches the model ONLY through the proxy. If strict in-container reviewer execution requires an architectural decision beyond assembling existing pieces, ESCALATE it (return prUrl:null + the open question) rather than inventing a resolution (per the OQ-resolution governance).
- [ ] #4 A benign untrusted PR produces real 3-reviewer verdicts → consensus.approved:true → unsigned report → Stage 4 clean-room sign → a v6 attestation that verifies status=valid (validated live on the fork harness `ai-sdlc-enterprise/ai-sdlc-ucvg-test` — operator/loop-gated; the dev provides the wiring + hermetic tests + documents the live-validation step).
- [ ] #5 Hermetic tests (reuse the 508 `_spawnProcess` / injectable-seam pattern + the 510 proxy seams) cover proxy start/stop, env wiring, the InferenceProxyClient path, and credential withholding — without a real daemon. Patch coverage ≥80% on changed non-test source.
- [ ] #6 Re-enable the real integration path in `.github/workflows/untrusted-pr-gate.yml` (AISDLC-519 removed `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` as a stopgap) so the gate runs real reviewers when a credential is configured — keeping fail-closed when it is not.
- [ ] #7 build/test/lint/format clean; no AISDLC-NNN tracker IDs in runtime/workflow-echoed strings; isolated mkdtemp; no shared /tmp/.ai-sdlc.
<!-- AC:END -->

## Notes

This is the security-critical core of RFC-0043 (AQ2 was the operator's explicit architecture
choice). Reconcile with an operator-composed/-reviewed security verdict (per the
security-critical manual-sign pattern), then validate live on the fork harness before
claiming "send a live demo" is true. Discovered during the AISDLC-514 e2e (2026-06-05);
prerequisite plumbing fixed by AISDLC-519.
<!-- SECTION:NOTES -->
