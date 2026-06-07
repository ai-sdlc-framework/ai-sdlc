---
id: AISDLC-522
title: >-
  fix(RFC-0043): port fork-proven UCVG AQ2 fixes to ai-sdlc main (incl. 2
  general docker differential-test bugs)
status: Done
assignee: []
created_date: '2026-06-06 17:00'
labels:
  - rfc-0043
  - ucvg
  - security
  - aq2
  - bug
dependencies: []
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/cli/ucvg.ts
  - pipeline-cli/src/pipeline/clean-room-signer.ts
  - pipeline-cli/src/pipeline/reviewer-runner.ts
  - .github/workflows/untrusted-pr-gate.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The RFC-0043 UCVG live demo was proven end-to-end on a real fork harness (ai-sdlc-enterprise/ai-sdlc-ucvg-test) on 2026-06-05: a benign untrusted PR passes Stage 0→1→2(real Docker differential test, offline, 100% coverage)→3(real reviewers via the inference.local credential-withholding proxy, 3/3 approve)→4(clean-room v6 sign) with the v6 attestation verifying `status=valid` and `ai-sdlc/untrusted-pr-gate:success` posted; the three adversarial vectors block at Stage 1 with non-empty evidence. Confirmed on two consecutive green runs.

AISDLC-520 landed the base AQ2 wiring on `main`, but it does NOT actually pass a live demo — getting there required 8 additional fixes that currently live ONLY on the fork. This task ports them to `ai-sdlc` main so adopters get a working gate.

TWO of the fixes are GENERAL adopter-affecting bugs, independent of the demo, and should be prioritized:

1. **`docker run` never forwarded data env vars into the container.** `runDockerDifferentialTest` set `SANDBOX_PR_DIFF_B64` (and the fixture tarball) on the docker CLI *process* env, but `docker run` does not inherit host env — so the PR diff never reached the container and EVERY differential test silently fail-closed to `{upstreamSuitePassed:false,newTestsPassed:false,newCodeCoveragePct:0}`. Fix: `buildDockerRunArgs` adds explicit `-e SANDBOX_PR_DIFF_B64 -e SANDBOX_FIXTURE_B64`.
2. **seccomp profile passed as inline JSON.** `--security-opt seccomp=<json>` makes docker try to open the JSON as a file → container exit code 125. Fix: write the profile to a temp file (mode 0600, in the per-spawn cidDir) and pass `seccomp=<path>`.

Remaining fixes (UCVG-specific, but required for the demo / correctness):

3. `computePrDiff` (pipeline-cli/src/cli/ucvg.ts) returned a placeholder string instead of the real `git diff`; reviewers saw an empty diff. Now emits the real `git diff base...head` (data-only), with fixture re-rooting (`--relative=<subdir>/`) when `AI_SDLC_UCVG_FIXTURE_SUBDIR` is set.
4. Clean-room signer (pipeline-cli/src/pipeline/clean-room-signer.ts) emits one v6 transcript leaf per reviewer from the approved report before `signAndWriteV6Envelope` — the UCVG reviewer matrix runs in Stage 2/3 and never persisted leaves, so sign-v6 failed with "No transcript leaves found".
5. reviewer-runner.ts: ESM `import * as nodeHttp from 'node:http'` (was `require`, undefined in ESM); reviewer model defaults to `claude-sonnet-4-6`, overridable via `AI_SDLC_REVIEWER_MODEL` (the old hardcoded `claude-3-5-sonnet-20241022` 404s).
6. Fixture-demo differential mode (Option B, operator-chosen): `buildDifferentialTestScript` materializes a zero-dep fixture repo from `SANDBOX_FIXTURE_B64` (offline; no clone/install under `--network=none`); `ucvg.ts` stages `<workDir>/<AI_SDLC_UCVG_FIXTURE_SUBDIR>` as a base64 tarball into the sandbox env.
7. Workflow (.github/workflows/untrusted-pr-gate.yml): `node:22` sandbox image (has git, needed for `git apply`) with a retried host-side pre-pull (avoid intermittent exit-125 image-pull failures); `AI_SDLC_UCVG_FIXTURE_SUBDIR=ucvg-demo`; Stage-4 builds orchestrator + runs a `verifyV6Envelope` step asserting `status=valid` before posting success (AC#3).
8. Add the zero-dep `ucvg-demo/` fixture (node --test; its `test` script pipes coverage through awk to emit a `Lines: NN%` line the in-container coverage grep can parse).

Reference implementation: all 8 fixes are on the fork's `main` (ai-sdlc-enterprise/ai-sdlc-ucvg-test) as of 2026-06-05. The exact file list + rationale is recorded in operator memory `project_ucvg_live_demo_build.md`.

SECURITY-CRITICAL: this is trust-chain code (the gate that decides whether untrusted PRs get a signed attestation). Land via the manual-sign reconcile pattern — operator composes the verdict from real reviewer outputs; do NOT let the dev subagent self-attest. Workflow edits are in-scope for this operator-overseen internal task.

Decision context (resolved 2026-06-05, decision-rubric): Option B (minimal zero-dep fixture repo) for the live demo; Option A (mount the real monorepo base + deps) and Option C (affected-package scoping) remain production follow-ups for running differential tests against dependency-having repos offline — track separately if/when needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 buildDockerRunArgs forwards SANDBOX_PR_DIFF_B64 and SANDBOX_FIXTURE_B64 into the container via explicit -e flags; a unit test asserts both flags are present in the returned argv
- [ ] #2 The seccomp profile is written to a file and passed as --security-opt seccomp=<path> (never inline JSON); a unit test asserts the arg references a path, and the differential test no longer exits 125 on profile handling
- [ ] #3 Clean-room signer emits one v6 transcript leaf per reviewer (code/test/security) from the approved report before signing; a test asserts leaves are written and signAndWriteV6Envelope succeeds against them
- [ ] #4 computePrDiff returns the real git diff (base...head, data-only) and, when AI_SDLC_UCVG_FIXTURE_SUBDIR is set, re-roots paths to that subdir (--relative); tests cover both modes
- [ ] #5 reviewer-runner imports node:http via ESM and resolves the reviewer model from AI_SDLC_REVIEWER_MODEL with default claude-sonnet-4-6
- [ ] #6 buildDifferentialTestScript supports fixture-demo mode: when SANDBOX_FIXTURE_B64 is set it materializes the fixture offline and runs the base→apply→head test sequence without clone or install
- [ ] #7 pipeline-cli build + full test suite pass and PR patch coverage is >=80% (verified with scripts/check-pr-patch-coverage.mjs, not package-level)
- [ ] #8 The changes are landed via the security-critical manual-sign reconcile (operator-composed verdict from real reviewer outputs; no dev self-attestation)
<!-- AC:END -->
