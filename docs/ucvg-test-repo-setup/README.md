# UCVG Test-Repo Configuration — Setup Templates

This directory contains the configuration files and templates a maintainer drops
into a dedicated test repository to enable the Untrusted-Contributor Verification
Gate (UCVG, RFC-0043).

## What goes in the test repo

| File | Purpose |
|---|---|
| `.ai-sdlc/untrusted-pr-gate.yaml` | Gate configuration (protected paths, sandbox driver, resource limits) |
| `.ai-sdlc/trusted-reviewers.yaml` | Trusted-author allowlist (trust classifier input) |
| `.github/workflows/untrusted-pr-gate.yml` | The gate workflow (copied from this repo) |
| Signing-key setup | See `signing-key-setup.md` for key generation + GitHub Secret wiring |

## Quick setup

1. Copy `.ai-sdlc/untrusted-pr-gate.yaml` → `<test-repo>/.ai-sdlc/untrusted-pr-gate.yaml`
2. Copy `trusted-reviewers.yaml` → `<test-repo>/.ai-sdlc/trusted-reviewers.yaml`
3. Copy the workflow: `cp .github/workflows/untrusted-pr-gate.yml <test-repo>/.github/workflows/`
4. Follow `signing-key-setup.md` to generate an ed25519 key and wire its PEM content as the `AISDLC_SIGNING_KEY_CONTENT` secret
5. Set repository variable `AI_SDLC_UNTRUSTED_PR_GATE=1` to enable the gate
6. Open a fork PR from an untrusted account and observe the gate fire

## Operator-gated steps (AC#3 and AC#4)

The following acceptance criteria require a live operator-executed run:

- **AC#3**: A benign fork PR flows through all four stages and produces a valid v6 attestation
- **AC#4**: Adversarial fork PRs (AISDLC-513 vectors) are blocked at the correct stage

These steps cannot be executed by a dev subagent — they require:
- A configured test repository with real fork PRs
- A real signing key wired as the `AISDLC_SIGNING_KEY_CONTENT` secret
- A live GitHub Actions runner with Docker enabled
- `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` set (or the runner has real Docker access)

See `../operations/e2e-real-repo-runbook.md` for the full operator runbook.
