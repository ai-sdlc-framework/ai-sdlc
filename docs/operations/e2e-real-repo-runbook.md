# UCVG End-to-End Real-Repo Runbook

**RFC-0043 Phase 7 — Operator-executed run**

This runbook covers how to reproduce the end-to-end UCVG pipeline on a real repository
using a real fork PR and live Docker runtime. It also documents the feature-flag flip
criteria (when to set `vars.AI_SDLC_UNTRUSTED_PR_GATE=1`).

## Overview

The Untrusted-Contributor Verification Gate (UCVG) runs four stages when a fork PR
is opened by an untrusted contributor:

```
[Stage 0] Trust Classification (deterministic, no LLM, no sandbox)
       ↓
[Stage 1] AST / Protected-Path Gate (deterministic, no LLM, no sandbox)
       ↓
[Stage 2/3] Docker Sandbox + Differential Tests + Hardened Reviewer Matrix
       ↓
[Stage 4] Clean-Room Attestation (signing key only here)
```

Stages 0-1 run for every PR; Stages 2-4 only run when Stage 1 passes.

## Prerequisites

Before running the e2e test:

1. A GitHub repository configured with the gate (see `docs/ucvg-test-repo-setup/`)
2. `AI_SDLC_UNTRUSTED_PR_GATE=1` set as a repository variable
3. `AISDLC_SIGNING_KEY_CONTENT` (or `AISDLC_SIGNING_KEY_PATH`) set as a repository secret
4. `ANTHROPIC_API_KEY` set as a repository secret (for Stage 2/3 reviewers)
5. A GitHub account that is NOT in `.ai-sdlc/trusted-reviewers.yaml` (for testing untrusted path)
6. Docker available on the runner (GitHub-hosted `ubuntu-latest` runners include Docker)

## Step-by-step: e2e run with a benign fork PR (AC#3)

> **This step is OPERATOR-GATED.** It cannot be executed by the dev subagent.
> AC#3 (benign fork PR → valid attestation) requires a live operator-executed run.

1. **Fork the test repo** from the untrusted GitHub account.

2. **Open a benign PR** from the fork:
   - Change a `.ts` or `.md` file (e.g. add a comment to a source file)
   - The diff must NOT touch protected paths (`.github/**`, `**/package.json`, etc.)
   - Push to the fork and open a PR against the test repo's `main` branch

3. **Observe the workflow** in GitHub Actions:
   - `Stage 0+1: Trust Classification + AST Gate` should fire first
   - Stage 0 should classify the author as `untrusted` (not in trusted-reviewers.yaml)
   - Stage 1 should pass (no protected-path violations)
   - `Stage 2/3: Sandbox + Hardened Reviewer Matrix` should start
   - Docker container is spun up; differential tests run
   - `Stage 4: Clean-Room Attestation` runs after Stage 2/3 succeeds
   - `ai-sdlc/untrusted-pr-gate: success` status posted on the PR commit

4. **Verify the attestation**:
   ```bash
   # After Stage 4 completes, the attestation envelope is in .ai-sdlc/ucvg/reports/
   # Run the verifier locally:
   node scripts/verify-attestation.mjs --head-sha <pr-head-sha>
   # Expected: status=valid
   ```

5. **Check the report artifact**:
   - Download the `ucvg-unsigned-report-<pr-number>` artifact from the Actions run
   - Verify `consensus.approved === true`
   - Verify all four stages are recorded

## Step-by-step: adversarial fork PR run (AC#4)

> **This step is OPERATOR-GATED.** AC#4 (adversarial PRs blocked at correct stage)
> requires a live operator-executed run using the AISDLC-513 adversarial fixture corpus.

The adversarial fixture corpus lives at:
`pipeline-cli/src/pipeline/ucvg-threat-fixtures.ts`

Each fixture represents a threat vector. Expected blocking stages:

| Threat vector | Expected blocking stage |
|---|---|
| Protected-path mutation (`.github/workflows/`) | Stage 1 (AST gate) |
| `package.json` lifecycle script injection | Stage 1 (content heuristics) |
| New `uses:` reference to unvetted GitHub Action | Stage 1 (content heuristics) |
| Malicious TypeScript with shell exec | Stage 2 (differential test failure) |
| Resource-exhausting test suite | Stage 2 (wall-clock limit breach) |

To run adversarial tests:

1. Create PRs from the untrusted fork containing the adversarial diff
2. Observe each PR is blocked at the expected stage
3. Verify the correct label (`needs-maintainer-review`) is applied
4. Verify the correct commit status is posted (`failure`)

## Feature-flag flip criteria

Set `vars.AI_SDLC_UNTRUSTED_PR_GATE=1` when ALL of the following are true:

- [ ] **Stage 0/1 hermetic tests pass**: `pnpm --filter @ai-sdlc/pipeline-cli test` green
- [ ] **Workflow YAML tests pass**: `node --test .github/workflows/__tests__/untrusted-pr-gate.test.mjs` green
- [ ] **Signing key is wired**: `AISDLC_SIGNING_KEY_CONTENT` secret set in the target repo
- [ ] **Trusted-reviewers list is accurate**: all current maintainers in `.ai-sdlc/trusted-reviewers.yaml`
- [ ] **AC#3 operator run complete**: benign fork PR produced `status=valid` attestation
- [ ] **AC#4 operator run complete**: all AISDLC-513 adversarial vectors blocked at correct stage
- [ ] **Docker confirmed on runners**: `ubuntu-latest` confirmed to have Docker available

Until AC#3 and AC#4 are operator-verified on the live gate, the UCVG cannot be
declared as a true live-demo milestone. Do NOT offer external live demos until AC#3
and AC#4 are confirmed.

## Degradation path

When Docker is unavailable on the runner (e.g. self-hosted runner without Docker,
or Docker daemon not running), the gate FAILS CLOSED:

1. Stage 1 still runs (deterministic, no sandbox needed)
2. Stage 2/3 detects Docker is unavailable and posts `failure` status
3. `needs-maintainer-review` label is applied
4. The gate blocks — never auto-approves when the sandbox cannot run

To verify the degradation path in CI:
- The `check-sandbox.outputs.degraded == 'true'` branch handles this case
- The Decision Catalog receives a `untrusted-pr-gate-degraded-mode` record
- Operator monitors via `node pipeline-cli/bin/cli-decisions.mjs list`

## Monitoring

- Workflow runs: GitHub Actions tab of the target repository
- Gate status per PR: the `ai-sdlc/untrusted-pr-gate` commit status on each PR
- Degradation events: `node pipeline-cli/bin/cli-decisions.mjs list --scope ucvg`
- Report artifacts: `ucvg-unsigned-report-<pr-number>` in GitHub Actions artifacts

## Rollback

To disable the gate:
1. Set `vars.AI_SDLC_UNTRUSTED_PR_GATE` to any non-truthy value (e.g. `0` or `off`)
2. The `flag-off-status` job posts a neutral `success` status
3. Existing review path runs as before

The gate is stateless — no database or persistent state to clean up.
