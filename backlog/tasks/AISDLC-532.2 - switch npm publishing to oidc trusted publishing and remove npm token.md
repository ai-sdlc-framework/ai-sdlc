---
id: AISDLC-532.2
title: 'Switch npm publishing to OIDC trusted publishing and remove NPM_TOKEN'
status: To Do
assignee: []
created_date: '2026-11-07'
labels:
  - chore
  - security
  - release
  - ci:no-issue-required
dependencies:
  - AISDLC-532.1
references:
  - .github/workflows/release.yml
  - docs/operations/release-flow.md
  - package.json
priority: medium
dispatchable: false
dispatchableReason: 'Operator precondition: register a GitHub Actions trusted publisher (org ai-sdlc-framework, repo ai-sdlc, workflow release.yml) for each of @ai-sdlc/orchestrator, @ai-sdlc/reference, @ai-sdlc/pipeline-cli, @ai-sdlc/mcp-advisor, @ai-sdlc/plugin-mcp-server on npmjs.com, then flip dispatchable.'
---

## Description

**Source.** Step (b) of the umbrella task AISDLC-532 by operator ruling 2026-11-07. The `publish-npm` job in `.github/workflows/release.yml` runs `pnpm -r publish --no-git-checks --provenance` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`, a long-lived classic token. The job already has `id-token: write` and `registry-url` set, and the `publish-pypi` job in the same file already publishes through OIDC trusted publishing. With pnpm 10 on `main` (AISDLC-532.1) and the five packages registered as trusted publishers on npmjs.com (operator precondition above), the token can go.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the release needs a credential npm accepts; a workflow identity is one, and a secret that must be rotated is not a requirement. 2. Deleted: `NODE_AUTH_TOKEN` from the publish step's `env`, the `--provenance` flag and `NPM_CONFIG_PROVENANCE` (provenance is automatic under trusted publishing), the `NPM_TOKEN` recovery comments at the top of the workflow, and finally the `NPM_TOKEN` secret itself (operator step). 3. Simplified: `permissions: id-token: write` and `registry-url` stay as they are; nothing else in the job changes. 4. Accelerated: no token rotation on the release path. 5. Automated: the next release run is the validation; `docs/operations/release-flow.md` records that any new publishable package needs its own trusted-publisher entry before its first publish.

Sequence: (1) operator registers the five trusted publishers and flips `dispatchable`; (2) this PR lands; (3) the next release's `publish-npm` job is watched for E401/E403 and for provenance attestations; (4) the operator deletes the `NPM_TOKEN` secret.

## Acceptance Criteria

- [ ] #1 The `publish-npm` job in `.github/workflows/release.yml` no longer references `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `--provenance` or `NPM_CONFIG_PROVENANCE`; `id-token: write` and `registry-url` are retained; the workflow tests under `.github/workflows/__tests__/` assert it.
- [ ] #2 The next release run publishes all five packages through trusted publishing (no E401/E403) and the registry shows provenance attestations for them; the run URL is recorded in the PR or its follow-up comment.
- [ ] #3 `docs/operations/release-flow.md` documents trusted publishing and the per-package trusted-publisher requirement for any new package.
- [ ] #4 (operator) The `NPM_TOKEN` GitHub Actions secret is deleted once the trusted-publishing release run above has succeeded, noted on the PR.

## Ruling 2026-11-07 (operator, decision rubric)

Option A of the 2026-11-07 ruling on AISDLC-532: the pnpm major (AISDLC-532.1) and the `release.yml` switch land as two reversible steps; the token is removed only after a release has published through OIDC. Counter-argument (a pnpm major during a pending release is risky) rebutted because the release path does not change until this task. npm began deprecating classic tokens after the 2025 supply-chain worm incidents; PyPI in this same workflow already publishes via OIDC.

## References

- `.github/workflows/release.yml`: `publish-npm` job (publish step and its `env`), `publish-pypi` job as the OIDC precedent.
- `docs/operations/release-flow.md`.
