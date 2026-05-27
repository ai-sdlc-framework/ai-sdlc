---
id: AISDLC-439
title: 'feat(release): sign MCP server npm tarball SHA inside DSSE attestation predicate at release time (DEC-0001)'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - supply-chain
  - attestation
  - release-workflow
  - dec-0001
dependencies: []
references:
  - .github/workflows/release.yml
  - ai-sdlc-plugin/mcp-server/package.json
  - .ai-sdlc/trusted-reviewers.yaml
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - .ai-sdlc/_decisions/events.jsonl
priority: high
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-385 moved MCP server distribution from in-tree git bundle to npm tarball. Operators installing the plugin pull `@ai-sdlc/mcp-server` from npm registry, and Claude Code's plugin install layer invokes the server binary. If the npm registry is compromised (typosquatting, account hijack, registry MITM), a malicious tarball gets installed silently — the MCP server then runs with full plugin trust (hook pipeline access, operator credentials in env, repo write access).

DEC-0001 (Decision Catalog, resolved 2026-05-26): add a release-time DSSE attestation predicate that signs the tarball SHA-512, verified at install/runtime against the operator's trusted-reviewers pubkey set (same trust root used for v6 review attestations).

## Scope

- **Release-time signing**: extend `.github/workflows/release.yml` so after `pnpm -r publish` succeeds for `@ai-sdlc/mcp-server`, the workflow computes the published tarball's SHA-512, packages it into a DSSE attestation predicate (`predicateType: 'https://ai-sdlc.io/mcp-server-tarball/v1'`), and signs it with the operator's release-time signing key.
- **Envelope distribution**: write the signed envelope to `.ai-sdlc/attestations/mcp-server-<version>.dsse.json` AND publish it as an npm tag asset (or as a separate `@ai-sdlc/mcp-server-attestation` package) so install-time verifiers can fetch it without git access.
- **Install-time verifier**: add a check in `ai-sdlc-plugin/hooks/check-plugin-version.sh` (or a new dedicated hook) that on plugin SessionStart, fetches the MCP server's installed tarball SHA, downloads the matching DSSE envelope, validates the signature against `.ai-sdlc/trusted-reviewers.yaml` pubkeys, and refuses to start the MCP server (surfacing an operator-actionable error) if the signature is invalid or the SHA doesn't match.
- **Compose with v6 Merkle infra**: reuse `ai-sdlc-plugin/scripts/sign-attestation.mjs` (or extract a shared helper) — don't fork crypto code.
- **Operator runbook**: document the new release step in `docs/operations/release-flow.md` AND a new `docs/operations/mcp-server-signing.md` explaining the verification flow, pubkey rotation, and operator recovery if a signature fails.

## Non-goals

- Signing other npm packages (only `@ai-sdlc/mcp-server` in this task; `@ai-sdlc/pipeline-cli` etc. follow up).
- Migrating away from `trusted-reviewers.yaml` to a different trust model.
- Replacing npm registry trust (this layer ADDS to it; doesn't replace).

## DEC-0001 resolution rationale

Picked DSSE-signed tarball (Option A) over:
- **Option B (npm-native `--provenance`)**: would introduce GitHub OIDC as a second trust anchor; reusing trusted-reviewers gives ONE policy-stable anchor.
- **Option C (revert to in-tree bundle)**: re-introduces the friction AISDLC-385 just eliminated.
- **Option D (status quo)**: npm registry compromise IS in the threat model; zero work is unacceptable.

Composes with DEC-0002 (AISDLC-440 — ship npm-shrinkwrap.json) for defense-in-depth.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.github/workflows/release.yml` extended with a post-publish step that computes the published `@ai-sdlc/mcp-server` tarball SHA-512 and signs it inside a DSSE envelope
- [ ] #2 Envelope distributed to operators (npm tarball asset OR sibling `@ai-sdlc/mcp-server-attestation` package OR `.ai-sdlc/attestations/mcp-server-<version>.dsse.json` published to a known location)
- [ ] #3 Install-time verifier (hook or MCP-server pre-init check) reads the envelope, validates signature against `.ai-sdlc/trusted-reviewers.yaml` pubkey set, and refuses to start MCP server on signature failure
- [ ] #4 Verifier uses the same trusted-reviewers pubkey set as v6 review attestations (single trust root, no new pubkey config)
- [ ] #5 Operator-actionable error on signature failure (names the expected vs actual SHA, points at the trusted-reviewers entry, hints at recovery path)
- [ ] #6 Hermetic tests cover: signed-envelope round-trip; signature failure path; SHA mismatch path; envelope-missing path; pubkey-not-trusted path
- [ ] #7 Operator runbook (`docs/operations/mcp-server-signing.md`) covers the verification flow, pubkey rotation, and operator recovery
- [ ] #8 80%+ patch coverage on new code (per `.husky/pre-push` coverage gate)
<!-- AC:END -->
